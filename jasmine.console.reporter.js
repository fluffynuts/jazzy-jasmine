var jasmine = jasmine || {};
(function(ns) {
/**
 * Original code largely from:
 * https://github.com/larrymyers/jasmine-reporters/blob/master/src/jasmine.console_reporter.js
 *
 * Basic reporter that outputs spec results to the browser console.
 * Useful if you need to test an html page and don't want the TrivialReporter
 * markup mucking things up.
 *
 * Usage:
 *
 * jasmine.getEnv().addReporter(new jasmine.JazzyConsoleReporter());
 * jasmine.getEnv().execute();
 */
    var JazzyConsoleReporter = function(startedLogMarker, finishedLogMarker) {
      this.verbose = false;
      this.started = false;
      this.finished = false;
      this.startedLogMarker = startedLogMarker || "JazzyConsoleReporter::STARTED"
      this.finishedLogMarker = finishedLogMarker || "JazzyConsoleReporter::FINISHED"
      this.failedInfo = [];
    };
    JazzyConsoleReporter.prototype = {
        reportRunnerResults: function(runner) {
            var dur = (new Date()).getTime() - this.start_time;
            var failed = this.executed_specs - this.passed_specs;
            var spec_str = this.executed_specs + (this.executed_specs === 1 ? " spec, " : " specs, ");
            var fail_str = failed + (failed === 1 ? " failure in " : " failures in ");
            this.log("Runner Finished.");
            this.log(spec_str + fail_str + (dur/1000) + "s.");
            if (failed) {
              this.log("Failures:");
              for (var spec in this.failedInfo) {
                this.log("  " + spec);
                var items = this.failedInfo[spec];
                for (var i = 0; i < items.length; i++) {
                  this.log("    " + items[i]);
                }
              }
            }
            this.finished = true;
            this.log(this.finishedLogMarker);
        },

        reportRunnerStarting: function(runner) {
            this.started = true;
              this.start_time = (new Date()).getTime();
              this.executed_specs = 0;
              this.passed_specs = 0;
              this.log("Runner Started.");
            this.log(this.startedLogMarker);
        },

        reportSpecResults: function(spec) {
              var resultText = "FAILED";

              if (spec.results().passed()) {
                  this.passed_specs++;
                  resultText = "PASSED";
              } else {
                // TODO: try to get a line number for the failure
                if (this.failedInfo[spec.suite.description] === undefined)
                  this.failedInfo[spec.suite.description] = [spec.description];
                else
                  this.failedInfo[spec.suite.description].push(spec.description);
              }
              //seen = [];
              //this.log(JSON.stringify(spec, function (key, val) {
              //  if (typeof(val) == "object") {
              //    if (seen.indexOf(val) >= 0) {
              //      return undefined;
              //    }
              //    seen.push(val);
              //  }
              //  return val;
              //}));
              if (this.verbose)
                this.log([resultText, " :: ", spec.description].join(""));
        },

        reportSpecStarting: function(spec) {
                this.executed_specs++;
                if (this.verbose)
                  this.log(spec.suite.description + ' : ' + spec.description + ' ... ');
        },

        reportSuiteResults: function(suite) {
                var results = suite.results();
                if (this.verbose)
                  this.log(suite.description + ": " + results.passedCount + " of " + results.totalCount + " passed.");
        },

        log: function(str) {
            var console = ns.getGlobal().console;
            if (console && console.log) {
                console.log(str);
            }
        }
    };

    function suiteResults(suite) {
        var results = suite.results();
        startGroup(results, suite.description);
        var specs = suite.specs();
        for (var i in specs) {
            if (specs.hasOwnProperty(i)) {
                specResults(specs[i]);
            }
        }
        var suites = suite.suites();
        for (var j in suites) {
            if (suites.hasOwnProperty(j)) {
                suiteResults(suites[j]);
            }
        }
        console.groupEnd();
    }

    function specResults(spec) {
      console.log("specResults");
        var results = spec.results();
        startGroup(results, spec.description);
        var items = results.getItems();
        for (var k in items) {
            if (items.hasOwnProperty(k)) {
                itemResults(items[k]);
            }
        }
        console.groupEnd();
    }

    function itemResults(item) {
      console.log("itemResults");
        if (item.passed && !item.passed()) {
            console.warn({actual:item.actual,expected: item.expected});
            item.trace.message = item.matcherName;
            console.error(item.trace);
        } else {
            console.info('Passed');
        }
    }

    function startGroup(results, description) {
      console.log("startGroup");
        var consoleFunc = (results.passed() && console.groupCollapsed) ? 'groupCollapsed' : 'group';
        console[consoleFunc](description + ' (' + results.passedCount + '/' + results.totalCount + ' passed, ' + results.failedCount + ' failures)');
    }

    // export public
    ns.JazzyConsoleReporter = JazzyConsoleReporter;
})(jasmine);

