'use strict';

/*jshint latedef:false*/

var debug = require('debug')('mservicebus');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var amqplib = require('amqplib/callback_api');
var _ = require('lodash');
var async = require('async');
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
		if(key === 'requestFulfillments'){
			self._initRequestFulfillments();
		}

		if(key === 'pubsub'){
			self._initPubSub();
		}
	});

	self.on('terminate', function(){
		self._terminateRequestFulfillments();
		self._terminatePubSub();
	});

	self.on('init:requests', function(){
		debug('%s Ready for requests', self._instanceId, self._requestCallbackQueue, self._requestCallbackConsumerTag);
	});

	self.on('init:pubsub', function(){
		debug('%s Ready for pubsub', self._instanceId);
	});

	self.on('init:fulfillments', function(qualifier){
		debug('%s Ready for fulfillment', self._instanceId, qualifier);
	});

	self.on('init:subscriptions', function(patterns){
		debug('%s Ready for subscriptions', self._instanceId, patterns);
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
 * Connects the servicebus to the AMQP message broker. Emits the 'connected' event
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
		'requestFulfillments',
		'pubsub'
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

Servicebus.prototype._initRequestFulfillments = function(){
	var self = this;
	if(!(self._channels && self._channels.requestFulfillments)){
		self.once('channelOpened:requestFulfillment', self._initRequestFulfillments.bind(self));
		return;
	}
	
	self._activeRequests = self._activeRequests || {};
	self._requestsConfig = self._requestsConfig || {};

	var channel = self._channels.requestFulfillments;
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
					self.emit.apply(self, ['received:RequestCallback', request.qualifier].concat(callbackArgs));
					self.emit.apply(self, ['received:RequestCallback'+request.qualifier].concat(callbackArgs));
					delete self._activeRequests[requestId];
				}
				else{
					self.emit.apply(['error', 'unknownRequestCallback', request.qualifier].concat(callbackArgs));
				}
			},
			{
				noAck:true,
				//exclusive:true
			},
			function(consumeErr, consumer){
				if(consumeErr){
					self.emit('error', err);
					return;
				}
				self._requestCallbackConsumerTag = consumer.consumerTag;
				self.emit('init:requestFulfillments');
			}
		);
	});
};

Servicebus.prototype._terminateRequestFulfillments = function(){
	var self = this;
	if(self._channels.requestFulfillments){
		if(self._requestCallbackConsumerTag){
			self._channels.requestFulfillments.cancel(self._requestCallbackConsumerTag);
		}
		if(self._requestCallbackQueue){
			self._channels.requestFulfillments.deleteQueue(self._requestCallbackQueue);
		}
		_.forEach(self._fulfillments, function(fulfillment){
			self._channels.requestFulfillments.cancel(fulfillment.consumerTag);
			self._channels.requestFulfillments.deleteQueue(fulfillment.qualifier);
			fulfillment.isActive = false;
		});
	}
};
/**
 * Request
 *
 * Dispatches a request for fulfillment
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
		return self.once('connected', callAgain);
	}

	if(!(self._channels && self._channels.requestFulfillments && self._requestCallbackQueue)){
		return self.once('init:requestFulfillments', callAgain);
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

	self._channels.requestFulfillments.sendToQueue(
		qualifier,
		new Buffer(JSON.stringify(requestArgs)),
		{
			replyTo: self._requestCallbackQueue,
			correlationId: request.requestId
		}
	);

	self.emit('push:request', qualifier, requestArgs);
	self.emit('push:request:'+ qualifier, requestArgs);

	return self;
};


Servicebus.prototype._initFulfillment = function(fulfillment){
	var self = this;

	function callAgain(){
		self._initFulfillment(fulfillment);
	}

	if(!(self._channels && self._channels.requestFulfillments)){
		self.once('channelOpened:requestFulfillments', callAgain);
		return;
	}

	var queue = fulfillment.qualifier;
	var channel = self._channels.requestFulfillments;
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
			self.emit.apply(self, ['received:fulfillmentRequest', queue].concat(args));
			self.emit.apply(self, ['received:fulfillmentRequest' + queue].concat(args));
		},
		{noAck:false},
		function(err){
			if(err){
				debug('could not consume requests', err);
				self._disconnect();
			}
			fulfillment.isActive = true;
			self.emit('init:fulfillment', fulfillment.qualifier);
		}
	);
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

	self._fulfillments[qualifier] = self._fulfillments[qualifier] || {
		qualifier:qualifier,
		functionStack: new FunctionStack()
	};
	var fulfillment = self._fulfillments[qualifier];

	if(fulfillment.functionStack.wrapped && fn){
		throw new Error('A fulfiller has already been registered for '+ qualifier);
	}
	
	if(fn){
		fulfillment.functionStack.wrap(fn);
	}

	self._initFulfillment(fulfillment);

	return fulfillment.functionStack;
};

Servicebus.prototype._initPubSub = function(){
	var self = this;
	if(!(self._channels && self._channels.pubsub)){
		self.once('channelOpened:publications', self._initPubSub.bind(self));
		return;
	}

	var channel = self._channels.pubsub;

	if(!self._pubsubExchangeAsserted){
		channel.assertExchange(self._pubsubExchange, 'topic', {durable:true}, function(exErr, ok){
			if(exErr){
				self.emit('error', 'pubsubexchange', exErr);
				return;
			}

			self._pubsubExchangeAsserted = self._pubsubExchange === ok.exchange;
			self.emit('init:pubsub');
			_.forEach(self._subscriptions, function(s){
				self._initSubscription(s);
			});
		});
		return;
	}
};

Servicebus.prototype._terminatePubSub = function(){
	var self = this;
	if(self._publicationCallbackConsumerTag && self._channels.pubsub){
		self._channels.pubsub.cancel(self._publicationCallbackConsumerTag);
	}
	if(self._channels.pubsub){
		_.forEach(self._subscriptions, function(subscription){
			self._channels.pubsub.deleteQueue(subscription.subscriptionId);
			if(subscription.consumerTag){
				self._channels.pubsub.cancel(subscription.consumerTag);
			}
			subscription.isActive = false;
		});
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
		if(self._pendingPublications && self._pendingPublications.length >0){
			self._pendingPublications.pop();
		}
		self.publish.apply(self, args);
	}

	self._pendingPublications = self._pendingPublications || [];
	
	if(!self._connection){
		self.once('connected', callAgain);
		self._pendingPublications.push(args);
		return self;
	}

	if(!self._channels.pubsub){
		self.once('init:pubsub', callAgain);
		self._pendingPublications.push(args);
		return self;
	}
	
	self._channels.pubsub.publish(
		self._pubsubExchange,
		topic,
		new Buffer(JSON.stringify(event))
	);

	self.emit('push:publication', topic, event);
	self.emit('push:publication:'+topic, event);

	return self;
};

Servicebus.prototype._initSubscription = function(subscription){

	var self = this;

	function callAgain(){
		self._initSubscription(subscription);
	}

	if(!(self._channels && self._channels.pubsub)){
		self.once('channelOpened:pubsub', callAgain);
		return;
	}

	if(!self._pubsubExchangeAsserted){
		self.once('init:pubsub', callAgain);
		return;
	}

	var channel = self._channels.pubsub;
	var queue = subscription.id;

	async.waterfall([
		function(cb){
			channel.assertQueue(
				queue,
				{durable:false, exclusive:false, autoDelete:true},
				function(qErr, ok){return cb(qErr, (ok||{}).queue);}
			);
		},
		function(queue, cb){		
			async.eachSeries(subscription.topicPatterns, function(pattern, doneBind){
				channel.bindQueue(queue, self._pubsubExchange, pattern, {}, doneBind);
			}, cb);
		},
		function(cb){
			channel.consume(
				queue,
				function(msg){
					var evt = JSON.parse(msg.content.toString());
					var topic = msg.fields.routingKey;
					channel.ack(msg);
					debug('%s Pushing %s event to %s subscribers', self._instanceId, topic, subscription.subscribers.length);
					_.forEach(subscription.subscribers, function(fnStack, index){
						fnStack.call(topic, evt, _.noop);
					});
					process.nextTick(function(){
						self.emit.apply(self, ['received:subscribedPublication', topic].concat(evt));
						self.emit.apply(self, ['received:subscribedPublication:'+ topic].concat(evt));
					});
				},
				{noAck: false},
				cb
			);
		},
		function(ok, cb){
			subscription.isActive = true;
			subscription.consumerTag = ok.consumerTag;
			cb();
		}
	], function(err){
		if(err){
			self.emit('error', err);
			return;
		}
		self.emit('init:subscription', subscription.topicPatterns);
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

	self._subscriptions = self._subscriptions || {};
	self._subscriptions[subscriptionId] = self._subscriptions[subscriptionId] || {
		topicPatterns: topicPatterns,
		id: subscriptionId,
		subscribers: [],
	};

	var subscription = self._subscriptions[subscriptionId];

	var subscriber = new FunctionStack(fn);
	subscription.subscribers.push(subscriber);

	if(subscription.isActive){return;}
	else{
		self._initSubscription(subscription);
	}

	return subscriber;	
};
