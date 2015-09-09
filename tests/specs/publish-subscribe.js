var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var Servicebus = require('../../');
var amqpUrl = process.env.AMQP_URL || 'amqp://192.168.59.103:5672';

describe('mservicebus publish-subscribe', function(){
	context('Separate publish and subscribe buses', function(){
		beforeEach(function(done){
			var ctx = this;
			ctx.subscribingBus = new Servicebus({
				serviceName: 'myservice',
				amqp:{
					url:amqpUrl
				}
			});
			ctx.subscribingBus.once('init:pubsub', function(){
				done();
			});
		});
		beforeEach(function(done){
			var ctx = this;
			ctx.publishingBus = new Servicebus({
				serviceName: 'myotherservice',
				amqp:{
					url:amqpUrl
				}
			});
			ctx.publishingBus.once('init:pubsub', function(){
				done();
			});
		});

		afterEach(function(done){
			var ctx = this;
			ctx.subscribingBus.close();
			ctx.publishingBus.close();
			setTimeout(done, 0);
		});
		
		it('Invokes only the correct subscriber', function(done){
			var ctx = this;
			var subscriber1 = sinon.stub();

			ctx.subscribingBus.subscribe('myservice.trade.tokyo.*', subscriber1);
			ctx.subscribingBus.subscribe('myservice.trade.nyse.*', function(qualifier, event){
				expect(qualifier).to.equal('myservice.trade.nyse.google');
				expect(event).to.have.property('price', '1234567');
				expect(subscriber1).to.not.have.been.called;
				done();
			});
			setTimeout(ctx.publishingBus.publish.bind(ctx.publishingBus, 'myservice.trade.nyse.google', {price:'1234567'}), 500);
		});
		
		it('Allows multiple local subscriptions to the same topic set', function(done){
			var ctx = this;
			var subscriber1 = sinon.stub();
			var subscriber2 = sinon.stub();

			ctx.subscribingBus.subscribe('myservice.multisubs.#', subscriber1);
			ctx.subscribingBus.subscribe('myservice.multisubs.#', subscriber2);
			setTimeout(ctx.publishingBus.publish.bind(ctx.publishingBus, 'myservice.multisubs.tradings', {price:'1234567'}), 1000);
			setTimeout(function(){
				expect(subscriber1).to.have.been.called;
				expect(subscriber2).to.have.been.called;
				done();
			}, 1500);
		});
	});
});
