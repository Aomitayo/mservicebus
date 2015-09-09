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
	self._fulfillments = {};

	// a map of subscriptions keyed by topic
	self._subscriptions = {};
	self._pubsubExchange = 'mservicebus_pubsub';

	//a map of requests keyed by correlationId/requestId	
	self._activeRequests = {};

	self.on('connected', self._assertChannels.bind(self));
	self.on('channelOpened', function(key){
		if(key === 'requests'){
			self._initRequestCallback();
		}
		if(key === 'fulfillments'){
			self._initFulfillments(self._fulfillments);
		}
		if(key === 'publications'){
			self._initPublications();
		}
		if(key === 'subscriptions'){
			self._initSubscriptions();
		}
	});

	self.on('terminate', function(){
		self._terminateRequestCallback();
		self._terminateSubscriptions();
		self._terminateFulfillments();
		self._terminatePublications();
	});

	//self.on('connected', self._attachFulfillers.bind(self, self._fulfillments));
	//self.on('connected', self._attachSubscribers.bind(self, self._subscriptions));
	//self.on('connected', self._startPublish.bind(self));

	//self.on('disconnected', self._detachRequestCallbacks.bind(self));
	//self.on('disconnected', self._detachFulfillers.bind(self, self._fulfillments));
	//self.on('disconnected', self._stopPublish.bind(self));

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
	
	amqplib.connect(self.options.amqp.url, function(err, connection){
		connection.on('close', function(){
			debug('%s Connection closed', self._instanceId);
			self.emit('disconnected');	
		});
		self._connection = connection;

		self.emit('connected');

		debug('%s Connected to message broker', self._instanceId);
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
	self.emit('terminate');
	setTimeout(function(){
		debug('%s Disconnecting from message broker', self._instanceId);
		if(self._connection){
			self._connection.close(function(){
				debug('%s disconnected', self._instanceId);
			});
		}
	}, 0);
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

	self.options.reconnect	= 0;
	self._disconnect();	
};

Servicebus.prototype._assertChannels = function(){
	var self = this;
	if(!self._connection){
		return self.once(self._assertChannels.bind(self));
	}

	self._channels = self._channels || {};
	var channelKeys = [
		'requests',
		'fulfillments',
		'publications',
		'subscriptions'
	];
	_.forEach(channelKeys, function(key){
		if(!self._channels[key]){
			self._connection.createChannel(function(err, channel){
				if(err){
					debug('%s Could not create requests channel', self._instanceId);
					self.emit('error', 'assertChannel:' + key, err);
				}
				else{
					channel.on('close', function(){
						delete self._channels[key];
					});
					self._channels[key] = channel;
					self.emit('channelOpened', key, channel);
					self.emit('channelOpened:'+key, channel);
				}
			});
		}
	});
};

Servicebus.prototype._initRequestCallback = function(){
	var self = this;
	if(!(self._channels && self._channels.requests)){
		self.once('channelOpened:requests', self._initRequestCallback.bind(self));
		return;
	}
	
	self._activeRequests = self._activeRequests || {};
	self._requestsConfig = self._requestsConfig || {};

	var channel = self._channels.requests;
	channel.assertQueue('', {exclusive:true, durable:false}, function(err, ok){
		if(err){
			self.emit('error', err);
		}
		
		self._requestCallbackQueue = ok.queue;

		channel.consume(
			self._requestCallbackQueue,
			function(msg){
				if(!msg){return;}
				var callbackArgs = JSON.parse(msg.content.toString());
				var requestId = msg.properties.correlationId;
				var request = self._activeRequests[requestId];
				if(request){
					clearTimeout(request.timeout);
					request.callback.apply(self, callbackArgs);
					self.emit.apply(self, ['RequestFullfilled', request.qualifier].concat(callbackArgs));
					delete self._activeRequests[requestId];
				}
				else{
					self.emit.apply(['error', 'invalidRequestFulfillment', request.qualifier].concat(callbackArgs));
				}
			},
			{
				noAck:true,
				//exclusive:true
			},
			function(err, consumer){
				self._requestCallbackConsumerTag = consumer.consumerTag;
				debug('%s Ready for requests', self._instanceId, self._requestCallbackQueue, self._requestCallbackConsumerTag);
				self.emit('init:requests');
			}
		);
	});
};

Servicebus.prototype._terminateRequestCallback = function(){
	var self = this;
	if(self._requestCallbackConsumerTag && self._channels.requests){
		self._channels.requests.cancel(self._requestCallbackConsumerTag);
	}
	if(self._requestCallbackQueue){
		self._channels.requests.deleteQueue(self._requestCallbackQueue);
	}
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

	if(!(self._channels && self._channels.requests && self._requestCallbackQueue)){
		return self.once('init:requests', callAgain);
	}
	var request = {
		qualifier: qualifier,
		requestId: uuid(),
		requestArgs: requestArgs,
		callback:callback,
		timeout: setTimeout(function(){
			var timeoutErr = new Error('The request has timed out perhaps target service has gone offline');
			timeoutErr.name = 'RequestTimeout';
			request.callback(timeoutErr);
		}, self.options.requestTimeout)
	};
	
	self._activeRequests[request.requestId] = request;

	self._channels.requests.sendToQueue(
		qualifier,
		new Buffer(JSON.stringify(requestArgs)),
		{
			replyTo: self._requestCallbackQueue,
			correlationId: request.requestId
		}
	);

	self.emit('request', qualifier, requestArgs);
	self.emit('request:'+ qualifier, requestArgs);

	return self;
};

Servicebus.prototype._initFulfillments = function(fulfillments){
	var self = this;
	if(!(self._channels && self._channels.fulfillments)){
		self.once('channelOpened:fulfillments', self.initFulfillments.bind(self, fulfillments));
	}

	fulfillments = fulfillments? fulfillments : self._fulfillments;

	var channel = self._channels.fulfillments;

	_.forEach(fulfillments, function(fulfillment){
		if(fulfillment.isActive){
			return;
		}
		
		var queue = fulfillment.qualifier;
		channel.assertQueue(queue, {durable:false, autoDelete:true});
		channel.prefetch(1);
		channel.consume(
			queue,
			function(msg){
				var args = JSON.parse(msg.content.toString());
				var fnStackArgs = args.concat(function(){
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
				fulfillment.functionStack.call.apply(fulfillment.functionStack, fnStackArgs);
				self.emit.apply(self, ['fulfill', queue].concat(args));
			},
			{noAck:false},
			function(err){
				if(err){
					debug('could not consume requests', err);
					self._disconnect();
				}
				self.emit('init:fulfillment', fulfillment.qualifier);
				self.emit('init:fullfillment:'+fulfillment.qualifier);
			}
		);

	});
};

Servicebus.prototype._terminateFulfillments = function(){
	var self = this;
	if(self._channels.fulfillments){
		_.forEach(self._fulfillments, function(fulfillment){
			self._channels.fulfillments.cancel(fulfillment.consumerTag);
			self._channels.fulfillments.deleteQueue(fulfillment.qualifier);
			fulfillment.isActive = false;
		});
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

	var fulfillment = self._fulfillments[qualifier] || {
		qualifier: qualifier,
		functionStack: new FunctionStack()
	};

	if(fulfillment.wrapped){
		throw new Error('A fulfillment has already been registered for '+ qualifier);
	}

	if(fn){
		fulfillment.functionStack.wrap(fn);
	}

	if(!fulfillment.isActive){
		var fulfillments = {};
		fulfillments[qualifier] = fulfillment;
		self._initFulfillments(fulfillments);
	}

	return fulfillment.functionStack;
};

Servicebus.prototype._initPublications = function(){
	var self = this;
	if(!(self._channels && self._channels.publications)){
		self.once('channelOpened:publications', self._initPublications.bind(self));
		return;
	}

	var channel = self._channels.publications;

	if(!self._pubsubExchange){
		channel.assertExchange(self._pubsubExchange, 'topic', {durable:true}, function(exErr){
			if(exErr){
				self.emit('error', 'pubsubexchange', exErr);
				return;
			}

			self._pubsubExchange = 'mservicebus_pubsub';
			self.emit('init:publications');
		});
		return;
	}
};

Servicebus.prototype._terminatePublications = function(){
	var self = this;
	if(self._publicationCallbackConsumerTag && self._channels.publications){
		self._channels.publications.cancel(self._publicationCallbackConsumerTag);
	}
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

	if(!self._channels.publications){
		self.once('readyForPublish', callAgain);
		return self;
	}
	
	self._channels.publications.publish(
		self._pubsubExchange,
		topic,
		new Buffer(JSON.stringify(event))
	);

	self.emit('publication', topic, event);
	self.emit('publication:'+topic, event);
	return self;
};

Servicebus.prototype._initSubscriptions = function(subscriptions){
	var self = this;
	if(!(self._channels && self._channels.subscriptions)){
		self.once('channelOpened:subscriptions', self.initSubscriptionCallback.bind(self, subscriptions));
		return;
	}
	if(!self._pubsubExchange){
		channel.assertExchange(self._pubsubExchange, 'topic', {durable:true}, function(exErr){
			if(exErr){
				self.emit('error', 'pubsubexchange', exErr);
				return;
			}

			self._pubsubExchange = 'mservicebus_pubsub';
			self._initSubscriptions(subscriptions);
		});
		return;
	}

	subscriptions = subscriptions? subscriptions : self._subscriptions;

	var channel = self._channels.subscriptions;

	_.forEach(subscriptions, function(subscription){
		if(subscription.isActive){
			return;
		}
		
		var queue = subscription.subscriptionId;

		channel.assertQueue(
			queue,
			{durable:false, exclusive:false, autoDelete:true},
			function(qErr){
				if(qErr){
					self.emit('error', 'subscriptionQueue', qErr, subscription);
					return;
				}
				_.forEach(subscription.topicPatterns, function(pattern){
					channel.bindQueue(queue, self._pubsubExchange, pattern, {}, function(bindErr){
						if(bindErr){
							self.emit('error', 'subscriptionQueue:bind', bindErr, pattern);
							return;
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
							self.emit('error', 'subscriptionConsume', consumeErr, subscription);
							return;
						}
						subscription.isActive = true;
						subscription.consumerTag = ok.consumerTag;
						self.emit('init:subscriptions', subscription);
					}
				);
			}
		);
	});
};

Servicebus.prototype._terminateSubscriptions = function(){
	var self = this;
	if(self._channels.subscriptions){
		_.forEach(self._subscriptions, function(subscription){
			self._channels.subscriptions.deleteQueue(subscription.subscriptionId);
			if(subscription.consumerTag){
				self._channels.subscriptions.cancel(subscription.consumerTag);
			}
			subscription.isActive = false;
		});
	}
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
	if(!subscription.isActive){
		var subscriptions = {};
		subscriptions[subscriptionId] = subscription;
		self._initSubscriptions(subscriptions);
	}

	return subscriber;	
};
