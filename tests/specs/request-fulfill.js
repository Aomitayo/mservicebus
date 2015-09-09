var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var Servicebus = require('../../');
var amqpUrl = process.env.AMQP_URL || 'amqp://192.168.59.103:5672';
var _ = require('lodash');

describe('mservicebus request-fulfill', function(){
	context('Separate request and fulfillment buses', function(){
		beforeEach(function(done){
			var ctx = this;
			ctx.fulfillingBus = new Servicebus({
				serviceName: 'acmebus',
				amqp:{
					url:amqpUrl
				}
			});
			ctx.fulfillingBus.once('init:requestFulfillments', function(){
				done();
			});
		});
		beforeEach(function(done){
			var ctx = this;
			ctx.requestingBus = new Servicebus({
				serviceName: 'acmebusConsumer',
				requestTimeout: 3000,
				amqp:{
					url:amqpUrl
				}
			});
			ctx.requestingBus.once('init:requestFulfillments', function(){
				done();
			});
		});

		afterEach(function(done){
			var ctx = this;
			ctx.fulfillingBus.close();
			ctx.requestingBus.close();
			setTimeout(done, 0);
		});
		
		it('Invokes only the correct actions', function(done){
			var ctx = this;
			var action1 = sinon.stub().yields(null, {resultValue:'resultValue1'});
			var action2 = sinon.stub().yields(null, {resultValue:'resultValue2'});

			ctx.fulfillingBus.fulfill('myservice.action1', action1);
			ctx.fulfillingBus.fulfill('myservice.action2', action2);
			ctx.fulfillingBus.on('init:fulfillment', _.after(2,function(){
				ctx.requestingBus.request('myservice.action1', {prop1:'value1'}, function(err, result){
					expect(action1).to.have.been.called;
					expect(action2).to.not.have.been.called;
					expect(result).to.have.property('resultValue', 'resultValue1');
					done();
				});
			}));	
		});
		it('Times out when there is no fulfilment', function(done){
			var ctx = this;
			ctx.requestingBus.request('myservice.timeoutaction', {prop1:'value1'}, function(err){
				expect(err).to.exist;
				expect(err).to.have.property('name', 'RequestTimeout');
				done();
			});
		});	
	});
});
