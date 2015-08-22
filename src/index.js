'use strict';

/*jshint latedef:false*/

var debug = require('debug')('mservicebus');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var amqplib = require('amqplib/callback_api');
var _ = require('lodash');
var uuid = require('node-uuid');
var FunctionStack = require('./function-stack');

module.exports = Servicebus;

function Servicebus(options){
	EventEmitter.call(this);
	var self = this;
	self.options = _.defaultsDeep(options || {}, {
		//a name for all instances of the service bus that should exchange 
		//messages. THis name is Used to derive an name for AMQP exhanges 
		//and other AMQP artifacts
		name: 'mservicebus-'+ uuid(),
		reconnect: 10,
		amqp:{
			url:'amqp://localhost:5672',
		}
	});

	//an id that uniquely identifies this instance of the servicebus.
	self._instanceId = self.options.name + '-' + uuid(); 


	//a map of fulfillers keyed by qualifier
	self._fulfillers = {};

	// a map of subscribers keyed by topic
	self.subscribers = {};
	
	//a map of requests keyed by correlationId	
	self._activeRequests = {};

	self.on('connection', self._attachRequestCallbacks.bind(self));
	self.on('connection', self._attachFulfillers.bind(self, self._fulfillers));

	self.on('disconnection', self._detachRequestCallbacks.bind(self));
	self.on('disconnection', self._detachFulfillers.bind(self, self._fulfillers));

	self._reconnect = self.options.reconnect;
	self.on('disconnection', function(){
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
	self._connect();
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
	debug('Connecting to message broker');

	amqplib.connect(self.options.amqp.url, function(err, connection){
		connection.on('close', self.emit.bind(self, 'disconnection'));
		self._connection = connection;

		debug('Connected to message broker');

		self.emit('connection');
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
	self.connection.close();

	debug('disconnecting from message broker');
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
	self.options.reconnect	= 0;
	
	if(!self._connection){
		return self.on('connection', self.close.bind(self));
	}

	self._connection.close(function(){
		debug('service bus closed');
	});
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
		return self.on('connection', callAgain);
	}

	if(!self._requestChannel){
		return self.on('readyForRequests', callAgain);
	}
	var request = {
		qualifier: qualifier,
		correlationId: uuid(),
		requestArgs: requestArgs,
		replyQueue: self._replyQueue,
		callback:callback
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
	self._connection.createChannel(function(err, channel){
		self._requestChannel = channel;
		self._requestChannel.on('close', function(){
			delete self._requestChannel;
			delete self._replyQueue;
		});

		self._requestChannel.assertQueue(self._replyQueue || '', {exclusive:true, durable:false}, function(err, ok){
			if(err){
				return self.disconnect();
			}
			self._replyQueue = ok.queue;
			self._requestChannel.consume(
				self._replyQueue,
				function(msg){
					if(!msg){return;}
					debug('Matching request: %s', msg.properties.correlationId);
					var request = self._activeRequests[msg.properties.correlationId];
					if(request){
						var callbackArgs = JSON.parse(msg.content.toString());
						request.callback.apply(self, callbackArgs);
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
					debug('Ready for requests', self._replyQueue, self._replyConsumerTag);
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
		self._attachFulfillers([fulfiller]);
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
		return self.on('connection', self._attachFulfillers.bind(self, fulfillers));
	}
	_.forEach(fulfillers, function(fulfiller, qualifier){
		if(fulfiller.channel){return;}
		debug('Attaching fulfiller ', qualifier);
		self._connection.createChannel(function(err, channel){
			if(err){
				self.disconnect();
			}

			channel.assertQueue(qualifier, {durable:true});
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

