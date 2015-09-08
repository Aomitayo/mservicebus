'use strict';

/*jshint latedef:false*/

var debug = require('debug')('mservicebus');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var amqplib = require('amqplib/callback_api');
var _ = require('lodash');
var uuid = require('node-uuid');
var crypto = require('crypto');
var FunctionStack = require('./function-stack');

module.exports = Servicebus;

function Servicebus(options){
	EventEmitter.call(this);
	var self = this;
	self.options = _.defaultsDeep(options || {}, {
		//A string used to define a scope of message exchange.
		//It is Used to derive names for message queues 
		//serviceName: 'service name',
		reconnect: 10,
		requestTimeout: 1*60*1000,
		amqp:{
			url:'amqp://localhost:5672',
		}
	});

	if(!self.options.serviceName){
		throw new Error('A service name must be specified for this service bus');
	}

	self._instanceId = self.options.serviceName + uuid();

	//a map of fulfillers keyed by qualifier
	self._fulfillers = {};

	// a map of subscriptions keyed by topic
	self._subscriptions = {};
	self.pubsubExchange = 'mservicebus_pubsub';

	//a map of requests keyed by correlationId	
	self._activeRequests = {};

	self.on('connected', self._attachRequestCallbacks.bind(self));
	self.on('connected', self._attachFulfillers.bind(self, self._fulfillers));
	self.on('connected', self._attachSubscribers.bind(self, self._subscriptions));
	self.on('connected', self._startPublish.bind(self));

	self.on('disconnected', self._detachRequestCallbacks.bind(self));
	self.on('disconnected', self._detachFulfillers.bind(self, self._fulfillers));
	self.on('disconnected', self._stopPublish.bind(self));

	self._reconnect = self.options.reconnect;
	self.on('disconnected', function(){
		if(self._reconnect){
			-- self._reconnect;
			self._connect();
		}
	});

	// be sure to close the service bus when the process is terminated
	process.once('SIGINT', function(){
		self.close();
	});
	
	//connect to the message broker
	process.nextTick(function(){
		self._connect();
	});
}

util.inherits(Servicebus, EventEmitter);


/**
 * _connect
 *
 * Connects the servicebus to the AMQP message broker. Emits the 'connection' event
 * when the connection has been established. 
 *
 * @return {undefined}
 */
Servicebus.prototype._connect = function(){
	var self = this;
	debug('%s Connecting to message broker', self._instanceId);

	amqplib.connect(self.options.amqp.url, function(err, connection){
		connection.on('close', function(){
			debug('%s Connection closed', self._instanceId);
			self.emit('disconnected');	
		});
		self._connection = connection;

		debug('%s Connected to message broker', self._instanceId);

		self.emit('connected');
	});
};

/**
 * _disconnect
 *
 * Disconnects the service bus from the message broker. 
 *
 * Servicebus will try to reconnect to the message broker based on the value of
 * the retry option.
 *
 * @return {undefined}
 */
Servicebus.prototype._disconnect = function(){
	var self = this;
	debug('%s Disconnecting from message broker', self._instanceId);
	if(self._connection){
		self._connection.close(function(){
			debug('%s disconnected', self._instanceId);
		});
	}
};

/**
 * close
 * Closes down the service bus, and stops it from reconnecting to the message 
 * broker.
 *
 * This should be called when terminating the process or when looking to discard
 * the servicebus instance.
 * 
 * By default, the servicebus calls this function when the process exits; 
 *
 * @return {undefined}
 */
Servicebus.prototype.close = function(){
	var self = this;
	debug('%s Closed', self._instanceId);
	self._detachRequestCallbacks();
	self._detachFulfillers();
	self._stopPublish();
	self._detachSubscribers();

	self.options.reconnect	= 0;
	self._disconnect();	
};

/**
 * Request
 *
 * Dispatches a request for fulfilment
 *
 * @param {String} qualifier - the name of the action to be invoked
 * @param {...Args} requestArgs - an variable list of arguments passed to request fulfillment 
 * @param {function} callback - a node-style callback that is called withthe results of the action
 * @return {undefined}
 */
Servicebus.prototype.request = function(){
	var self = this;
	var args = Array.prototype.slice.apply(arguments);
	var qualifier = _.head(args);
	var callback = _.last(args);
	var requestArgs = args.slice(1, -1);
	
	function callAgain(){
		self.request.apply(self, args);
	}

	if(!self._connection){
		return self.once('connection', callAgain);
	}

	if(!self._requestChannel){
		return self.once('readyForRequests', callAgain);
	}
	var request = {
		qualifier: qualifier,
		correlationId: uuid(),
		requestArgs: requestArgs,
		replyQueue: self._replyQueue,
		callback:callback,
		timeout: setTimeout(function(){
			var timeoutErr = new Error('The request has timed out perhaps target service has gone offline');
			timeoutErr.name = 'RequestTimeout';
			request.callback(timeoutErr);
		}, self.options.requestTimeout)
	};
	
	self._activeRequests[request.correlationId] = request;

	self._requestChannel.sendToQueue(
		qualifier,
		new Buffer(JSON.stringify(requestArgs)),
		{
			replyTo: request.replyQueue,
			correlationId: request.correlationId
		}
	);

	debug('Requesting: %s replyTo:%s correlationId:%s', qualifier, request.replyQueue, request.correlationId);
	self.emit('request', qualifier, requestArgs);

	return self;
};

/**
 * _attachRequestCallbacks
 *
 * Setup the channel, queue and consumer that calls request callbacks
 *
 * @return {undefined}
 */
Servicebus.prototype._attachRequestCallbacks =  function(){
	var self = this;
	debug('%s  Attaching request callbacks', self._instanceId);
	self._connection.createChannel(function(err, channel){
		if(err){
			debug('%s could not create request channel', self._instanceId, err);
			return self._disconnect();
		}
		self._requestChannel = channel;
		self._requestChannel.on('close', function(){
			delete self._requestChannel;
			delete self._replyQueue;
		});

		self._requestChannel.assertQueue(self._replyQueue || '', {exclusive:true, durable:false}, function(err, ok){
			if(err){
				return self._disconnect();
			}
			self._replyQueue = ok.queue;
			self._requestChannel.consume(
				self._replyQueue,
				function(msg){
					if(!msg){return;}
					debug('%s Matching request: %s', self._instanceId, msg.properties.correlationId);
					var request = self._activeRequests[msg.properties.correlationId];
					if(request){
						clearTimeout(request.timeout);
						var callbackArgs = JSON.parse(msg.content.toString());
						request.callback.apply(self, callbackArgs);
						self.emit('RequestFullfilled');
					}
					else{
						// silently discard the reply message that does not 
						// correspond to any request
					}
				},
				{
					noAck:true,
					//exclusive:true
				},
				function(err, consumer){
					self._replyConsumerTag = consumer.consumerTag;
					debug('%s Ready for requests', self._instanceId, self._replyQueue, self._replyConsumerTag);
					self.emit('readyForRequests');
				}
			);
		});
	});
};

/**
 * _detachRequestCallbacks
 * 
 * Stops the consumption of reply messages, and closes the channel
 *
 * @return {undefined}
 */
Servicebus.prototype._detachRequestCallbacks = function(){
	var self = this;
	if(self._replyConsumerTag && self._requestChannel){
		self._requestChannel.cancel(self._replyConsumerTag);
	}
	if(self._replyQueue){
		self._requestChannel.deleteQueue(self._replyQueue);
	}

	if(self._requestChannel){
		self._requestChannel.close();
	}
};

/**
 * Registers a fulfiller on the service bus.
 *
 * @param {String} qualifier - A unique name for the fulfiller
 * @param {function} - [fn] a function that is called when a request is 
 * made with the given qualifier. The function be set by calling
 * [bind()]{FunctionStack.bind} on the FunctionStack that is returned from the
 * function call. 
 *
 * @return {FunctionStack}
 */
Servicebus.prototype.fulfill = function(qualifier, fn){
	var self = this;
	var fulfiller = self._fulfillers[qualifier] || {
		qualifier:qualifier,
		functionStack: new FunctionStack()
	};

	if(!self._fulfillers[qualifier]){
		self._fulfillers[qualifier] = fulfiller;
	}
	if(fn && fulfiller.functionStack._wrapped){
		throw new Error('A fulfillment has already been registered for '+ qualifier);
	}

	if(fn){
		fulfiller.functionStack.wrap(fn);
	}

	if(!fulfiller.channel && self._connection){
		var fulfillers = {};
		fulfillers[qualifier] = fulfiller;
		self._attachFulfillers(fulfillers);
	}

	return fulfiller.functionStack;
};


/**
 * _attachFulfillers
 *
 * attached the fulfillers to the message broker
 *
 * @return {undefined}
 */
Servicebus.prototype._attachFulfillers = function(fulfillers){
	var self = this;
	if(!self._connection){
		return self.once('connection', self._attachFulfillers.bind(self, fulfillers));
	}
	_.forEach(fulfillers, function(fulfiller, qualifier){
		if(fulfiller.channel){return;}
		debug('Attaching fulfiller ', qualifier);
		self._connection.createChannel(function(err, channel){
			if(err){
				return self._disconnect();
			}

			channel.assertQueue(qualifier, {durable:false, autoDelete:true});
			channel.prefetch(1);
			channel.consume(
				qualifier,
				function(msg){
					debug('received request', qualifier);
					var args = JSON.parse(msg.content.toString());
					args = args.concat(function(){
						debug('fulfilling %s replyTo:%s correlationId: %s', qualifier, msg.properties.replyTo, msg.properties.correlationId);
						var callbackArgs = Array.prototype.slice.apply(arguments);
						callbackArgs = JSON.stringify(callbackArgs);

						channel.sendToQueue(
							msg.properties.replyTo,
							new Buffer(callbackArgs),
							{
								correlationId: msg.properties.correlationId
							}
						);
						channel.ack(msg);
					});
					fulfiller.functionStack.call.apply(fulfiller.functionStack, args);
				},
				{noAck:false},
				function(err){
					if(err){
						debug('could not consume requests', err);
						self._disconnect();
					}
				}
			);
			fulfiller.channel = channel;
			channel.on('close', function(){
				delete fulfiller.channel;
			});
			debug('Attached fulfiller', qualifier);
		});
	});
};

/**
 * _detachFulfillers
 *
 * Stops request fulfilment by Temporarily closing down  fulfiller's channels.
 *
 * @return {undefined}
 */
Servicebus.prototype._detachFulfillers = function(){
	var self = this;
	_.forEach(self.fulfillers, function(fulfiller){
		if(fulfiller.channel){
			fulfiller.channel.close();
		}
	});
};


/**
 * subscribe
 *
 * Registers an event subscriber on the service bus.
 *
 * @param {String|String[]} topicPatterns - AMQP topic pattern string or array
 * @param {function} - [fn] a function that is called when a event is published
 * with a matching topic pattern. The function can also be set by calling
 * [bind()]{FunctionStack.bind} on the FunctionStack that is returned from the
 * function call. 
 *
 * @return {FunctionStack}
 */
Servicebus.prototype.subscribe = function(topicPatterns, fn){
	var self = this;
	
	topicPatterns = Array.isArray(topicPatterns)? topicPatterns : [topicPatterns];

	var subscriptionId = topicPatterns.sort().join('');
	subscriptionId = crypto.createHash('md5').update(subscriptionId).digest('hex');
	subscriptionId = self.options.serviceName + '.' + subscriptionId;

	var subscriber = new FunctionStack(fn);

	self._subscriptions[subscriptionId] = self._subscriptions[subscriptionId] || {
		topicPatterns: topicPatterns,
		subscriptionId: subscriptionId,
		subscribers: []
	};

	var subscription = self._subscriptions[subscriptionId];
	subscription.subscribers.push(subscriber);

	//attach this subscriber if connection to message broker is already open
	if(self._connection && subscription.subscribers.length === 1){
		var subscriptions = {};
		subscriptions[subscriptionId] = subscription;
		self._attachSubscribers(subscriptions);
	}

	return subscriber;	
};

/**
 * _attachSubscribers
 *
 * @return {Servicebus}
 */
Servicebus.prototype._attachSubscribers = function(subscriptions){
	var self = this;

	if(!self._connection){
		return self.once('connection', self._attachSubscribers.bind(self, subscriptions));
	}

	_.forEach(subscriptions, function(subscription){
		if(subscription.channel){return;}
		debug('%s Attaching subscription:', self._instanceId, subscription.topicPatterns);
		self._connection.createChannel(function(chErr, channel){
			if(chErr){
				return self._disconnect();
			}
			var exchange = self.pubsubExchange;

			channel.assertExchange(exchange, 'topic', {durable:true}, function(exErr){
				if(exErr){
					debug('%s Unable to assert %s exchange', self._instanceId, exchange);
					return self._disconnect();
				}
				var queue = subscription.subscriptionId;

				channel.assertQueue(
					queue,
					{durable:false, exclusive:false, autoDelete:true},
					function(qErr){
						if(qErr){
							debug('%s Unable to asssert queue %s', self._instanceId. subscription.subscriptionId);
							return self._disconnect();
						}
						_.forEach(subscription.topicPatterns, function(pattern){
							channel.bindQueue(queue, exchange, pattern, {}, function(bindErr){
								if(bindErr){
									debug('%s Unable to bind queue %s to exchange %s for pattern %s', self._instanceId, queue, exchange, pattern);
									self._disconnect();
								}
							});
						});
						channel.consume(
							queue,
							function(msg){
								var evt = JSON.parse(msg.content.toString());
								var topic = msg.fields.routingKey;
								debug('%s Pushing %s event to subscription ', self._instanceId, topic);
								_.forEach(subscription.subscribers, function(fnStack){
									fnStack.call(topic, evt, _.noop);
								});
								channel.ack(msg);
							},
							{noAck: false},
							function(consumeErr, ok){
								if(consumeErr){
									debug('%s Unable to initiate consumption from %s via %s', self._instanceId, queue, exchange);
									return self._disconnect();
								}

								subscription.channel = channel;
								channel.on('close', function(){delete subscription.channel;});
								subscription.consumerTag = ok.consumerTag;
								self.emit('subscribed', subscription.topicPatterns);
								debug('%s Attached subscription:', self._instanceId, subscription.topicPatterns);
							}
						);
					}
				);
			});
		});
	});

	return self;
};

Servicebus.prototype._detachSubscribers = function(){
	var self = this;
	_.forEach(self.subscriptions, function(subscription){
		if(subscription.channel){
			subscription.channel.close();
			self.emit('unsubscribed', subscription.topicPatterns);
		}
	});
};
/**
 * publish
 *
 * @param {String} topic - The topic under which to publish the event
 * @param {Object} event - the event to be published to subscribers
 * @return {Servicebus}
 */
Servicebus.prototype.publish = function(topic, event){ 
	var self = this;
	var args = Array.prototype.slice.apply(arguments);

	function callAgain(){
		self.publish.apply(self, args);
	}

	if(!self._connection){
		self.once('connection', callAgain);
		return self;
	}

	if(!self._publishChannel){
		self.once('readyForPublish', callAgain);
		return self;
	}
	
	self._publishChannel.publish(
		self.pubsubExchange,
		topic,
		new Buffer(JSON.stringify(event))
	);

	debug('%s Publishing %s', self._instanceId, topic);
	return self;
};

Servicebus.prototype._startPublish = function(){
	var self = this;
	debug('%s prepareing for pub sub', self._instanceId);
	self._connection.createChannel(function(err, channel){
		if(err){
			debug('%s could not create request channel', self._instanceId, err);
			return self._disconnect();
		}

		channel.assertExchange(self.pubsubExchange, 'topic', {durable:true}, function(exErr){
			if(exErr){
				debug('%s Unable to assert exchange %s', self._instanceId, self.pubsubExchange);
			}
			self._publishChannel = channel;
			self._publishChannel.on('close', function(){
				delete self._publishChannel;
				delete self._replyQueue;
			});
			debug('%s Ready for publish', self._instanceId);
			self.emit('readyForPublish');

		});
	});
};


Servicebus.prototype._stopPublish = function(){
	var self = this;
	if(self._publishChannel){
		self._publishChannel.close();
	}	
};
