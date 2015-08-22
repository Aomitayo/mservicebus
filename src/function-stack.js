/**
 * FunctionStack
 * @module
 *
 * Utility for wrapping an asynchronous function  with a stack of asynchronous
 * "middleware" functions and an optional stack of asynchronous error handler
 * functions.
 *
 * Each middleware function should have the signature function(..args, next).
 * `args` are arguments to the function, and `next` is a callback function
 * with the signature function(err, results).
 * 
 * The functions in the stack control the flow of control by calling `next` with
 * either an error or a result.
 *
 * calling next() without arguments passes execution to the next function in 
 * the stack.
 * Calling `next(err)` - with a value as the first argument causes the stack to execute
 * the error handlers registered on the stack.
 *
 * Calling `next(null, result)` - with a value as the second arguments causes 
 * The action stack to stop executing and call the the callback of the of the 
 * run method with the result.
 *
 */
'use strict';
/* jshint latedef:false */
var _ = require('lodash');

module.exports = FunctionStack;

/**
 * FunctionStack
 * @constructor 
 *
 * @return {FunctionStack}
 */
function FunctionStack(wrapped){
	var self = this;
	
	self._fnStack = [];
	self._errorHandlerStack = [];
	self.wrapped = wrapped;
}

/**
 * wrap
 *
 * Sets the wrapped function
 *
 * @param wrapped
 * @return {undefined}
 */
FunctionStack.prototype.wrap = function(wrapped){
	this.wrapped = wrapped;
	return this;
};


/**
 * _put
 * Places the given function into the given stack  at the given position
 *
 * @param {Array} stack
 * @param {(String| Number)} position - The position at which to insert the 
 * function.
 * @param {function} fn
 * @return {FunctionStack}
 */
FunctionStack.prototype._put = function(stack, position, fn){
	var self = this;

	if(typeof position === 'function' && !fn){
		fn = position;
		position = undefined;
	}

	if(typeof position === 'string'){
		var positionIndex = _.findIndex(stack, function(f){
			return f.name === position;
		});
		if(positionIndex === -1){
			throw new Error('No function named \'' + position + '\' could be found on the stack');
		}
		position = positionIndex;
	}

	if(typeof position === 'number'){
		stack.splice(position, 0, fn);
		return self;
	}

	if(typeof position === 'undefined'){
		stack.push(fn);
		return self;
	}

	throw new Error('position should be  the name of an action function or an integer');
	return self;
};
/**
 * put
 *
 * Places a function into the stack at a desired position.
 *
 * @param {(String| Number)} position - The position at which to insert the 
 * function.
 * @param fn
 * @return {FunctionStack}
 */
FunctionStack.prototype.put = function(position, fn){
	var self = this;

	return self._put(self._fnStack, position, fn);
};

/**
 * putBefore
 *
 * an alias for put 
 *
 * @return {undefined}
 */
FunctionStack.prototype.putBefore = FunctionStack.prototype.put;
/**
 * use
 *
 * Adds a function to the bottom of the stack
 *
 * @param fn
 * @return {FunctionStack}
 */
FunctionStack.prototype.use = function(fn){
	var self = this;
	self.put(self._fnStack.length, fn);
	return self;
};

/**
 * push
 *
 * Adds a function to the top of the stack
 *
 * @param {function} fn
 * @return {FunctionStack}
 */
FunctionStack.prototype.push = function(fn){
	var self = this;
	self.put(0, fn);
	return self;
};

/**
 * addErrorHandler
 * Registers an error handler.
 *
 * @param position
 * @param fn
 * @return {undefined}
 */
FunctionStack.prototype.addErrorHandler = function(position, fn){
	var self = this;
	self._put(self._errorHandlerStack, position, fn);
	return self;
};

/**
 * A function called after an action has been run. 
 * @callback stackRunCallback
 * @param err - Error object, or null
 * @param {Any} results - The result from running the action if any
 */

/**
 * call
 * 
 * Runs the stack of functions or errorHandlers before calling the wrapped 
 * function if it has been set. The callback is passed to the wrapped function,
 * which can call it with an error and or results.
 *
 * If an error any of the middleware functions calls next with an error, and the
 * error is not handled by the stack of errorHandlers, then the callback is 
 * called with the error as its first parameter
 *
 * @param {...Any} arg - The arguments to be passed to each function in the stack
 * @param {stackRunCallback} callback - function(err, result) called after executing the stack.
 * @return {FunctionStack}
 */
FunctionStack.prototype.call = function(){
	var self = this;
	var args = Array.prototype.slice.apply(arguments);
	var fnStack = self.wrapped? self._fnStack.concat(self.wrapped) : self._fnStack;
	args.unshift(fnStack);
	args.push(self._errorHandlerStack);	
	self._runStack.apply(self, args);
	return self;
};

/**
 * _runStack
 * 
 * Runs a stack of asynchronous function.
 *
 * calls the callback with the results or the error -if any.
 *
 * @param [Array] stack - The stack of function to run.
 * @param {...Any} args - The arguments to be passed to each function in the stack
 * @param {stackRunCallback} callback - The callback that handles the result
 * @param {function[]} [errorHandlerStack] -  A array of error handler functions
 * @return {FunctionStack}
 */
FunctionStack.prototype._runStack = function(){
	var self = this;

	var args = Array.prototype.slice.call(arguments, 0);
	var stack = _.head(args);
	var errorHandlerStack = _.last(args);
	var callback, runArgs;

	if(Array.isArray(errorHandlerStack)){
		callback = _.head(args.slice(-2));
		runArgs = args.slice(1, -2);
	}
	else{
		callback = errorHandlerStack;
		errorHandlerStack = undefined;
		runArgs = args.slice(1, -1);
	}
	if(typeof callback !== 'function'){
		throw new Error('function stack callback should be a function');
	}

	function invokeNext(stk, err, result){
		if(err){
			if(errorHandlerStack && errorHandlerStack.length > 0){

				var errArgs = [errorHandlerStack, err].concat(runArgs).concat(callback);
				return self._runStack.apply(self, errArgs);
			}
			else{
				return callback(err);
			}
		}

		if(typeof result !== 'undefined'){
			return callback(null, result);
		}

		if(stk.length === 0){
			return callback(err, result);
		}
		_.head(stk).apply(self, runArgs.concat(_.partial(invokeNext, _.rest(stk))));
		//_.head(stk)(cmd, _.partial(invokeNext, _.rest(stk)));
	}
	invokeNext(stack);
	return self;
};
