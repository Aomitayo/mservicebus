'use strict';

/*jshint latedef:false */

var debug = require('debug')('mservicebus.action');
var util = require('util');
var _ = require('lodash');
var async = require('async');
var FunctionStack = require('./function-stack');

module.exports = Action;

/**
 * constructor
 *
 * @param {String} name - A name for the action.
 * @return {Action}
 */
function Action(name){
	FunctionStack.call(this);
	var self = this;
	self.name = name;
}

util.inherits(Action, FunctionStack);
