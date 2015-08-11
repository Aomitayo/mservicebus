'use strict';

/*jshint latedef:false*/

var debug = require('debug')('mservicebus');
var async = require('async');
var amqplib = require('amqplib/callback_api');
var _ = require('lodash');
var uuid = require('node-uuid');

var Action = require('./action');

module.exports = Servicebus;

function Servicebus(options){
	var self = this;
	self.options = _.defaultsDeep(options || {}, {
		reconnect: true,
		amqp:{
			url:'amqp://localhost:5672',
			exchangeName:'servicebus',
		}
	});
	
	// A map of actions	
	self._actions = {};

	self._initRegistrationQueues();

	// a queue of actions to be invoked.
	self._actionInvocationQueue = async.queue(self._invokeAction.bind(self));
	self._actionInvocationQueue.pause();

	self._connect();
	// be sure to close the service bus when the process is terminated
	process.once('SIGINT', function(){
		self.close();
		process.exit();
	});
}

/**
 * close
 * Closes down the service bus, and stops it from reconnecting to the message 
 * broker.
 *
 * This should be called when terminating the process or when looking to discard
 * the servicebus instance.
 * 
 * @return {undefined}
 */
Servicebus.prototype.close = function(){
	var self = this;
	
	if( self._connection){
		self._connection.close();
		delete self._connection;
		self.options.reconnect = false;
	}
	debug('service bus closed');
};

/**
 * Define an action on the service bus
 *
 * @param {String} actionName - A unique name for the action
 * @param {function} - [optional] a function that is called when the action is invoked
 *
 * @return {Action}
 */
Servicebus.prototype.action = function(actionName, fn){
	var self = this;
	var action = self._getOrDefineAction(actionName);
	if(fn){action.add(fn);}

	return action;
};

/**
 * invoke
 * Invokes an action registered by a microservice attached to the service bus.
 *
 * @param {String} actionName - the name of the action to be invoked
 * @param {Object} args - an object that will be passed to the action handler 
 * @param {function} callback - a node-style callback that is called withthe results of the action
 * @return {undefined}
 */
Servicebus.prototype.invoke = function(actionName, args, callback){
	this._actionInvocationQueue.push({
		actionName:actionName,
		args:args,
		callback: callback
	});
};


/**
 * _initRegistrationQueues
 * Initializes the different queues that the service bus uses.
 *
 * @return {undefined}
 */
Servicebus.prototype._initRegistrationQueues = function(){
	var self = this;

	if(self._actionRegisterationQueue){
		self._actionRegisterationQueue.kill();
	}
	
	// A queue of actions waiting to be registered on the messaging 
	// infrastructure
	self._actionRegisterationQueue = async.queue(self._registerAction.bind(self));
	self._actionRegisterationQueue.pause();
	self._actionRegisterationQueue.push(_.values(self._actions));
	debug('initialized Registration queues');	
};

/**
 * _connect
 * Connects the service bus to the message broker. resumes registration of 
 * actions, subscribers, and stream providers. It also resumes the invocation
 * of actions, publication events and the replay of events.
 *
 * @return {undefined}
 */
Servicebus.prototype._connect = function(){
	var self = this;
	amqplib.connect(self.options.amqp.url, function(err, connection){
		connection.on('close', self._disconnect.bind(self));

		self._connection = connection;
		self._initRegistrationQueues();
		self._actionRegisterationQueue.resume();
		self._actionInvocationQueue.resume();
		debug('Connected to message broker');
	});
};

/**
 * _disconnect
 * Disconnects the service bus from the message broker. 
 * Stops the registeration of 
 * Pauses the registeration
 * of actions, subscribers and event replay providers. I also pauses the 
 * invocation of actions, event publication, and the replay of events.
 *
 * @return {undefined}
 */
Servicebus.prototype._disconnect = function(){
	var self = this;
	
	self._initRegistrationQueues();	
	self._actionInvocationQueue.pause();

	if(self.options.reconnect){self._connect();}

	debug('disconnected service bus');
};

/**
 * Retrives or defines an action given by the actionName.
 *
 * @param {String} actionName - A unique name for the action.   
 *
 * @return {undefined}
 */

Servicebus.prototype._getOrDefineAction = function(actionName){
	var self = this;
	var action = self._actions[actionName] || new Action(actionName);
	if(!self._actions[actionName]){
		self._actions[actionName] = action;
		self._actionRegisterationQueue.push(action);
	}
	return action;
};


/**
 * _registerAction
 * Setup the messaging mechanisms required to invoke the action.
 * @param {Action} action - The action to be registered
 * @param {function} callback - The function to be called when the registeration
 * is done.
 * @return {undefined}
 */
Servicebus.prototype._registerAction = function(action, callback){
	var self = this;

	self._connection.createChannel(function(err, channel){
		if(err){
			return callback(err);
		}
		channel.prefetch(1);
		channel.assertQueue(action.name, {durable:false}, function(err){
			if(err){
				//todo put code to handle failure to assertQueue here
				return console.log(err.stack);
			}
			var actionInvocation = function(msg){
				var args = JSON.parse(msg.content.toString());
				action.run(args, function(err, results){
					var callbackArgs = Array.prototype.slice.apply(arguments);

					channel.sendToQueue(
						msg.properties.replyTo,
						new Buffer(JSON.stringify(callbackArgs)),
						//new Buffer(JSON.stringify({
						//	error: err,
						//	results: results
						//})),
						{
							correlationId: msg.properties.correlationId
						}
					);
				});
			};
			channel.consume(action.name, actionInvocation,  {noAck:true}, function(err, serverReply){
				if(err){
					//todo put code to handle channel subscription error here
					return console.log(err.stack);
				}
				debug('Registered action %s', action.name);
				action._registerationInfo = serverReply;

				return callback();
			});
		});
	});
};

Servicebus.prototype._invokeAction = function(options, callback){
	var self = this;
	debug('Invoking action %s', options.actionName);
	self._connection.createChannel(function(err, channel){
		if(err){
			return callback(err);
		}

		channel.assertQueue('', {exclusive:true}, function(err, serverReply){
			if(err){
				return callback(err);
			}
			var replyQueue = serverReply.queue;
			var correlationId = uuid();
			channel.consume(replyQueue, function(msg){
				if(msg.properties.correlationId !== correlationId){
					debug('Invalid correlation', msg.correlationId);
					return callback(new Error('Unexpected message'));
				}

				try{
					var response = JSON.parse(msg.content.toString());
					debug('Action invoked %s', options.actionName);
					channel.close();
					options.callback.apply(self, response);
					callback();
				}
				catch(ex){
					callback(new Error('The message could not be parsed'));
				}

				channel.close();
			}, {noAck:true});
			channel.sendToQueue(options.actionName, new Buffer(JSON.stringify(options.args)), {
				replyTo:replyQueue, 
				correlationId:correlationId
			}, function(err, serverReply){
				if(err){
					debug(err);
					return callback(err);
				}
				debug('Action request sent', serverReply);
			});
		});
	});
};



