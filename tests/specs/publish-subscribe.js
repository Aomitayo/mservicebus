var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var Servicebus = require('../../');
var amqpUrl = process.env.AMQP_URL || 'amqp://192.168.59.103:5672';

describe('mservicebus publish-subscribe', function(){
	context('Separate publish and subscribe buses', function(){
		beforeEach(function(done){
			var context = this;

			context.subscribingBus = new Servicebus({
				serviceName: 'myservice',
				amqp:{
					url:amqpUrl
				}
			});
			context.publishingBus = new Servicebus({
				serviceName: 'myservice',
				amqp:{
					url:amqpUrl
				}
			});
			//wait for connections to settle
			setTimeout(done, 2000);

		});

		afterEach(function(){
			var context = this;
			context.subscribingBus.close();
			context.publishingBus.close();
		});
		
		it('Invokes only the correct subscriber', function(done){
			var context = this;
			var subscriber1 = sinon.stub();

			context.subscribingBus.subscribe('myservice.trade.tokyo.*', subscriber1);
			context.subscribingBus.subscribe('myservice.trade.nyse.*', function(qualifier, event){
				expect(qualifier).to.equal('myservice.trade.nyse.google');
				expect(event).to.have.property('price', '1234567');
				expect(subscriber1).to.not.have.been.called;
				done();
			});
			setTimeout(context.publishingBus.publish.bind(context.publishingBus, 'myservice.trade.nyse.google', {price:'1234567'}), 100);
		});
		
		it('Allows for multiple local subscribers to the same topic set', function(done){
			var context = this;
			var subscriber1 = sinon.stub();
			var subscriber2 = sinon.stub();

			context.subscribingBus.subscribe('myservice.multisubs.#', subscriber1);
			context.subscribingBus.subscribe('myservice.multisubs.#', subscriber2);
			setTimeout(context.publishingBus.publish.bind(context.publishingBus, 'myservice.multisubs.tradings', {price:'1234567'}), 100);
			setTimeout(function(){
				expect(subscriber1).to.have.been.called;
				expect(subscriber2).to.have.been.called;
				done();
			}, 150);
		});
	});
});
