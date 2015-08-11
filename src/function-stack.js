'use strict';
/* jshint latedef:false */
var _ = require('lodash');

module.exports = FunctionStack;

/**
 * FunctionStack
 * 
 * Defines a stack of asynchronous functions to be invoked in sequence.
 *
 * Each function should have the signature function(..args, next).
 * `args` are the arguments to the function, and `next` is a callback function
 * with the signature function(err, results).
 * 
 * The functions in the stack control the execution of the stack of functions by
 * calling `next` with either an error or a result.
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
 * @return {undefined}
 */
function FunctionStack(){
	var self = this;
	
	self._fnStack = [];
	self._errorHandlerStack = [];
}

/**
 * add
 * Adds a function to the stack
 *
 * @param {String| Number} position - The position at which to insert the 
 * function.
 * @param fn
 * @return {FunctionStack}
 */
FunctionStack.prototype.add = function(position, fn){
	var self = this;
	self._use(self._fnStack, position, fn);
	return self;
};

/**
 * addBefore 
 * an alias for FunctionStack#add
 *
 * @return {FunctionStack}
 */
FunctionStack.prototype.addBefore = FunctionStack.prototype.add;

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
	self._use(self._errorHandlerStack, position, fn);
	return self;
};

/**
 * _use
 *
 * Adds a function to the stack
 *
 * @param {String| Number} position - The position at which to insert the 
 * function.
 * @param fn
 * @return {FunctionStack}
 */
FunctionStack.prototype._use = function(stack, position, fn){
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
};

/**
 * A function called after an action has been run. 
 * @callback actionCallback
 * @param err - Error object, or null
 * @param {Any} results - The result from running the action if any
 */

/**
 * run
 * 
 * Runs the stack of functions used by this action.
 *
 * calls the callback with the results or the  first occurance of an error -if any.
 *
 * @param {...Any} arg - The arguments to be passed to each function in the stack
 * @param {actionCallback} callback - function(err, result) called after executing the stack.
 * @return {FunctionStack}
 */
FunctionStack.prototype.run = function(cmd, callback){
	var self = this;
	self._runStack(self._fnStack, cmd, callback);
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
 * @param {actionCallback} callback - The callback that handles the result
 * @return {FunctionStack}
 */
FunctionStack.prototype._runStack = function(){
	var self = this;

	var args = Array.prototype.slice.call(arguments, 0);
	var stack = _.head(arguments);
	var callback = _.last(arguments);
	args = args.slice(1, -1);

	function invokeNext(stk, err, result){
		if(err){
			if(self._runErrorStack){
				var errArgs = [self._errorHandlerStack || [], err].concat(args).concat(callback);
				return self._runErrorStack.apply(self, errArgs);
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
		_.head(stk).apply(self, args.concat(_.partial(invokeNext, _.rest(stk))));
		//_.head(stk)(cmd, _.partial(invokeNext, _.rest(stk)));
	}
	invokeNext(stack);
	return self;
};


/**
 * _runErrorStack
 * 
 * Runs a the stack of error handlers.
 *
 * calls the callback with the results or the error -if any.
 *
 * @param [Array] stack - The stack of function to run.
 * @param {Any} error - The error that occurred
 * @param {...Any} args - The arguments that were being passed to functions in the stack
 * @param {actionCallback} callback - The callback that handles the result
 * @return {Undefined}
 */
FunctionStack.prototype._runErrorStack = function(){
	var self = this;
	var args = Array.prototype.slice.call(arguments, 0);
	var stack = args[0];
	var error = args[1];
	var callback = _.last(args);
	args = args.slice(1, -1);

	function invokeNext(stk, err, result){
		if(typeof err !== 'undefined' && err === null){
			return callback(err);
		}

		if(typeof result !== 'undefined'){
			return callback(null, result);
		}

		if(stk.length === 0){
			return callback(error);
		}
		_.head(stk).apply(self, args.concat(_.partial(invokeNext, _.rest(stk))));
		//_.head(stk)(cmd, _.partial(invokeNext, _.rest(stk)));
	}
	invokeNext(stack);
};
