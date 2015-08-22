var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var Servicebus = require('../../');
var amqpUrl = process.env.AMQP_URL || 'amqp://192.168.59.103:5672';

describe('mservicebus action dispatch', function(){
	context('Separate request and fulfillment buses', function(){
		beforeEach(function(){
			var context = this;
			context.fulfillingBus = new Servicebus({
				amqp:{
					url:amqpUrl
				}
			});
			context.requestingBus = new Servicebus({
				amqp:{
					url:amqpUrl
				}
			});
		});

		afterEach(function(){
			var context = this;
			context.fulfillingBus.close();
			context.requestingBus.close();
		});
		
		it('Invokes only the correct actions', function(done){
			var action1 = sinon.stub().yields(null, {resultValue:'resultValue1'});
			var action2 = sinon.stub().yields(null, {resultValue:'resultValue2'});

			this.fulfillingBus.fulfill('myservice.action1', action1);
			this.fulfillingBus.fulfill('myservice.action2', action2);
			
			this.requestingBus.request('myservice.action1', {prop1:'value1'}, function(err, result){
				expect(action1).to.have.been.called;
				expect(action2).to.not.have.been.called;
				expect(result).to.have.property('resultValue', 'resultValue1');
				done();
			});
		});
	
	});
});
