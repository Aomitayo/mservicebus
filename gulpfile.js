'use strict';

// Include Gulp & Tools We'll Use
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var runSequence = require('run-sequence').use(gulp);

// Load custom tasks from the `build-tasks` directory
try {require('require-dir')('build-tasks'); } catch (err) {console.log(err.stack);}

// lint and test package, the Default Task
gulp.task('default', [], function (cb) {
	runSequence('lint', 'test', cb);
});


