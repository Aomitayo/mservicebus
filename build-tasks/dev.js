'use strict';
require('colors');
var _ = require('lodash');
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var runSequence = require('run-sequence').use(gulp);
var beep = require('beepbeep');
var dotenv = require('dotenv');
var mkenv = require('mkenv');
var fs = require('fs');

gulp.task('build-env', function(){
	return gulp.src('')
		.pipe($.shell([
			'boot2docker up',
			'$(boot2docker shellinit)',
			'DOCKER_HOST_IP_ADDR=$(boot2docker ip) && perl -p -e "s/DOCKER_HOST_IP/$DOCKER_HOST_IP_ADDR/" env.sample | perl -p -e "s/export //" > dev.env',
			'source dev.env && docker run -d --name mservicebus_rabbitmq -v /var/volumes/md4-rabbitmq:/var/lib/rabbitmq -p $AMQP_PORT:5672 -p $AMQP_MANAGEMENT_PORT:15672 rabbitmq:management'
		]))
		.pipe($.wait(10000));
});

gulp.task('set-env', function(){

	var menv = mkenv(dotenv.parse(fs.readFileSync('dev.env', 'utf-8')));

	_.assign(process.env, mkenv.vars(menv));
});

gulp.task('clean-env', function(){
	return $.shell.task([
		'docker stop mservicebus_rabbitmq',
		'docker rm mservicebus_rabbitmq'
	],{ignoreErrors:true})();
});

// Lint JavaScript
gulp.task('lint', function () {
	return gulp.src('src/**/*.js')
	.pipe($.jshint('.jshintrc'))
	.pipe($.jshint.reporter('jshint-stylish'));
});

gulp.task('test', function () {
	var testProcess = $.spawnMocha({
		t: 6000,
		R: 'spec'
	})
	.once('error', function () {
		beep(2);
		$.util.log('Looks like we have a problem'.bold.red);
		this.error = true;
		this.emit('end');
	})
	.once('end', function(){
		if(!this.error){beep();}
	});

	return gulp.src('tests/specs/**/*.js')
	.pipe(testProcess);
});

// Watch Files For Changes & rerun tests
gulp.task('watch', function () {
  gulp.watch(['src/**/*.js'], ['lint', 'test']);
  gulp.watch(['tests/**/*.js'], ['test']);
});


// Start a coding session: 
//	- prepare the development environment
//	- run code check
//	- run tests
//	- watch for changes to source code and tests, react accordingly
//	- Cleanup/destory the development environment when the coding session is ends
gulp.task('dev', function(callback){
	return runSequence('clean-env', 'build-env', 'set-env', 'lint', 'test', 'watch', callback);
});

