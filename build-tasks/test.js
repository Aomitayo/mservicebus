'use strict';

require('colors');
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var beep = require('beepbeep');

gulp.task('test', function () {
	return gulp.src('tests/specs/**/*.js')
	.pipe($.mocha({
		timeout: 4000,
		reporter: 'spec'
	}))
	.once('error', function () {
		beep(2);
		$.util.log('Looks like we have a problem'.bold.red);
		this.error = true;
		this.emit('end');
	})
	.once('end', function(){
		if(!this.error){beep();}
	});
});
