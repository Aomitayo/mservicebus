var _ = require('lodash');
var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var FunctionStack = require('../../src/function-stack');

describe('FunctionStack', function(){
	it('Invokes the function in a stack of one', function(done){
		var fn1 = sinon.stub().yields(null, {resultValue:'resultValue1'});
		var cmd1 = {cmd:'cmd1'};
		var fnStack = new FunctionStack();
		fnStack.add(fn1);
		fnStack.run(cmd1, function(err, results){
			expect(fn1).to.have.been.calledWith(cmd1);
			expect(results).to.have.property('resultValue', 'resultValue1');
			done();
		});
	});

	it('Invokes each function in the stack ', function(done){
		var fnStack = new FunctionStack();
		var fns = _.times(3, function(){
			var fn = sinon.stub().yields(null);
			fnStack.add(fn);
			return fn;
		});
		var cmd = {cmd:'cmd1'};
		fnStack.run(cmd, function(){
			fns.forEach(function(fn){
				expect(fn).to.have.been.called;
			});
			done();
		});
	});
	
	it('A function in the stack can stop execution of the stack', function(done){
		var fn1 = sinon.stub().yields(null);
		var fn2 = sinon.stub().yields(null, {result:'v1'});
		var fn3 = sinon.stub().yields(null);

		var fnStack = new FunctionStack();
		fnStack.add(fn1);
		fnStack.add(fn2);
		fnStack.add(fn3);

		var cmd = {cmd:'cmd1'};
		fnStack.run(cmd, function(err, results){
			expect(fn1).to.have.been.called;
			expect(fn2).to.have.been.called;
			expect(fn3).to.not.have.been.called;

			expect(results).to.have.property('result','v1');
			done();
		});
	});

	it('Reports the error from a stack function', function(done){
		var fn1 = sinon.stub().yields(null);
		var fn2 = sinon.stub().yields(new Error('Function error'));
		var fn3 = sinon.stub().yields(null);

		var fnStack = new FunctionStack();
		fnStack.add(fn1);
		fnStack.add(fn2);
		fnStack.add(fn3);

		var cmd = {cmd:'cmd1'};
		fnStack.run(cmd, function(err, results){
			expect(fn1).to.have.been.called;
			expect(fn2).to.have.been.called;
			expect(fn3).to.not.have.been.called;
			expect(err).to.be.an('error');
			expect(results).to.be.undefined;
			done();
		});

	});
});
