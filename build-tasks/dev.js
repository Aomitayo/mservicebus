'use strict';

var path = require('path');
var _ = require('lodash');
var minimatch = require('minimatch');
//var $ = require('gulp-load-plugins')();
var gulp = require('gulp');
var runSequence = require('run-sequence').use(gulp);


// Watch Files For Changes & rerun tests
gulp.task('watch', function () {
  gulp.watch(['src/**/*.js'], ['lint', 'unloadSUT', 'test']);
  gulp.watch(['tests/**/*.js'], ['unloadTests', 'test']);

});


// Watch Files For Changes & rerun tests
gulp.task('dev', function(callback){
	runSequence( 'lint', 'test', 'watch', callback);
});

gulp.task('unloadTests', function(){
	var patterns = ['tests/**/*.js']
		.map(_.ary(_.partial(path.join, process.cwd()), 1) );
	
	Object.keys(require.cache).filter(function(modulePath){
		return _.some(patterns, _.partial(minimatch, modulePath));
	})
	.forEach(function(stepModule){
		delete require.cache[stepModule];
	});
});

gulp.task('unloadSUT', function(){
	var patterns = ['src/**/*.js']
		.map(_.ary(_.partial(path.join, process.cwd()), 1) );
	
	Object.keys(require.cache).filter(function(modulePath){
		return _.some(patterns, _.partial(minimatch, modulePath));
	})
	.forEach(function(stepModule){
		delete require.cache[stepModule];
	});
});
