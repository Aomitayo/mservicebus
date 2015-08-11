'use strict';

var gulp = require('gulp');
var $ = require('gulp-load-plugins')();

// Lint JavaScript
gulp.task('lint', function () {
	return gulp.src('src/**/*.js')
	.pipe($.jshint('.jshintrc'))
	.pipe($.jshint.reporter('jshint-stylish'));
});