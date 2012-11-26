var Jazzy = Jazzy || {};
(function(ns) {
  phantom.onError = function(msg, trace) {
    var msgStack = ['ERROR: ' + msg];
    if (trace) {
      msgStack.push('Trace follows:');
      trace.forEach(function(t) {
        msgStack.push(' at ' + (t.file || t.sourceURL) + ': ' + t.line + ((t.function) ? ' (in function "' + t.function.toString() + '")' : ''));
      });
    }
    console.error(msgStack.join('\n'));
    phantom.exit();
  };
  var system = require("system");
  var fs = require("fs");
  fs.separator = "/";

  ns.running = null;
  ns.aborted = false;
  ns.coverageData = [];
  ns.injectedScripts = [];

  ns.findFile = function(fileName) {
    var filesBelowThis = ns.ls_r(".");
    var depth = -1;
    var match = null;
    for (var i = 0; i < filesBelowThis.length; i++) {
      var parts = filesBelowThis[i].split(fs.separator);
      var thisDepth = parts.length-1;
      if (parts[thisDepth] == fileName) {
        if ((depth < 0) || (thisDepth < depth)) {
          match = filesBelowThis[i];
          depth = thisDepth;
        }
      }
    }
    return match;
  };

  ns.injectJs = function(page, fileName) {
    fileName = fs.absolute(fileName);
    if (ns.injectedScripts.indexOf(fileName) > -1) {
      dlog("Skipping repeated injection for: " + fileName);
      return true;
    }
    dlog("real injection for: " + fileName);
    ns.injectedScripts.push(fileName);
    return page.injectJs(fileName);
  };

  ns.ls_r = function(dir) {
    var items = fs.list(dir);
    var result = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var fullPath = [dir, item].join(fs.separator);
      switch (item) {
        case ".":
        case "..":
          continue;
        default:
          if (fs.isDirectory(fullPath)) {
            result = result.concat(ns.ls_r(fullPath));
            continue;
          }
          result.push(fullPath);
      }
    }
    return result;
  };

  function logStr(thing) {
    switch(typeof(thing)) {
      case "string":
      case "number":
        return thing;
      default:
        if (thing instanceof Array) {
          var things = [];
          for (var i = 0; i < thing.length; i++) {
            things.push(logStr(thing[i]));
          }
          return things.join("");
        }
        seen = [];
        return JSON.stringify(thing, function (key, val) {
          if (typeof(val) == "object") {
            if (seen.indexOf(val) >= 0) {
              return undefined;
            }
            seen.push(val);
          }
          return val;
        });
    }
    return thing.toString();
  }

  function jlog(str) {
    console.log("Jazzy: " + logStr(str));
  };

  function dlog(str) {
    if (globalOptions.debug)
      console.log("Jazzy DEBUG: " + logStr(str));
  };

  var instrumentedFiles = [];       // lookup for report generation and cleanup
  var failedInstrumentations = [];  // cache instrumentation failures to speed up run

  ns.noiseRe = new RegExp("^[}{\\]\\[;)(]*$");
  ns.switchRe = new RegExp("^.*:$");
  ns.logicStartRe = new RegExp("^(if|else).*$");

  ns.coverableLine = function(line, debug) {
    // NB: expects a trimmed line with comments cleaned out
    function dlog(str) {
      if (debug) {
        jlog("coverableLine :: " + str);
      }
    }
    if (line.length == 0) {
      dlog("Not covering empty line");
      return false;
    }
    if (line[0] == ".") {
      dlog("Not covering line starting with period: " + line);
      return false; // this is actually naughty javascript (SLOW)
    }
    switch (line[line.length-1]) {
      // lines ending with certain characters are bound to be either problematic or not useful to cover
      case "|": // middle of logic operators: 
      case "&": //  only take this line if it is the start of the logic
        dlog("Testing line for logic: " + line);
        return (ns.logicStartRe.test(line));  
      case ",":
        dlog("Line ends with ,: " + line);
        return false;
        break;
      default:
        // lines which are just JS syntax noise aren't worth covering
        if (ns.noiseRe.test(line)) {
          dlog("line is noise: " + line);
          return false;
        } else if (ns.switchRe.test(line)) { // case statement and inside JSON
          dlog("line in switch: " + line);
          return false;
        } else {
          // look for part of a JSON grouping
          var parts = line.split(":");
          if (parts.length == 1) {
            dlog("Inspecting line for JSON: " + line);
            dlog("end char: " + line.charCodeAt(line.length-1));
            switch (line[line.length-1]) {
              case ";":
              case "{":
              case "[":
                dlog("subcount for (: " + subcount(line, "("));
                dlog("subcount for ): " + subcount(line, ")"));
                return (subcount(line, "(") == subcount(line, ")"));
              default:
                return false;
            }
          }
          // first part should have none or just two quotes, at the start and end
          var quotes = subcount(parts[0], "\"");
          dlog("line has " + quotes + " quotes: " + line);
          switch (quotes) {
            case 0:
            case 2:
              while (line.length && (line[line.length-1] == ","))
                line = line.substr(0, line.length-1);
              try {
                var tryToEval = "var test = {" + line.replace(/"/g, "\\\"") + "};";
                eval(tryToEval);
                return !(typeof(test) === "object")
              } catch (e) {
                dlog("line un-evalable: " + line);
                return false;
              }
            default:
              dlog("line is coverable: " + line);
              return true;
          }
        }
    }
  }

  String.prototype.lastIndexOf = function(needle) {
    var idx = this.indexOf(needle);
    if (idx == -1) return -1;
    var lastIdx;
    while (idx > -1) {
      lastIdx = idx;
      idx = this.indexOf(needle, idx+1);
    }
    return lastIdx;
  };

  function subcount (str, substr) {
    var matches = 0;
    var idx = str.indexOf(substr);
    while (idx > -1) {
      matches++;
      idx = str.indexOf(substr, idx+1);
    }
    return matches;
  };

  ns.deComment = function(lines) {
    // eliminate comments to make instrumenting more useful
    var newLines = [];
    var inMultiLineComment = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim(); // ecma standard now
      var idx = line.indexOf("//");
      if (!inMultiLineComment && (idx > -1)) {
        newLines.push(line.substr(0, idx).trim());
        continue;
      }
      idx = line.indexOf("/*");
      if (idx > -1) {
        var end = line.lastIndexOf("*/");
        if (end == -1) {
          inMultiLineComment = true;
          end = line.length;
        }
        var deCommented = line.substr(0, idx) + line.substr(end + 2, line.length);
        newLines.push(deCommented.trim());
        continue;
      }
      if (inMultiLineComment) {
        idx = line.lastIndexOf("*/");
        if (idx > -1) {
          newLines.push(line.substr(idx + 2, line.length).trim());
          inMultiLineComment = false;
        } else
          newLines.push("");
        continue;
      }
      newLines.push(line);
    }
    return newLines;
  };

  ns.shortLogicRe = new RegExp("^(if|else|for).*[^{|^;]$");
  ns.braceShortLogic = function(lines) {
    // alter shorthand logic blocks to have braces to make instrumenting easier
    // NB: expects trimmed lines: should be called after deComment
    var newLines = [];
    var depth = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (depth)
        line += "}";
      if (ns.shortLogicRe.test(line) && (subcount(line, "(") == subcount(line, ")")))
        depth++;
      else if (depth)
        depth--;
      if (depth)
        newLines.push(line + "{");
      else
        newLines.push(line);
    };
    while (depth--) newLines[newLines.length-1] += "}";
    return newLines;
  };

  ns.prepareCode = function(lines) {
    lines = ns.deComment(lines);
    lines = ns.braceShortLogic(lines);
    return lines;
  };

  ns.instrumentFile = function(fpath, lines) {
    // failed before
    if (failedInstrumentations.indexOf(fpath) > -1)
      return fpath;
    // explicitly ignored by the code itself
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].replace(/\s/g, "").toLowerCase() == "//jazzy:ignore") {
        return fpath;
      }
    }
    // ignored by regex on the commandline
    var testPath = fpath.replace(/\\/g, "/");
    for (var i = 0; i < globalOptions.coverIgnores.length; i++) {
      var re = globalOptions.coverIgnores[i];
      if (re.test(fpath)) {
        dlog(["Skipping coverage on \"", fpath, "\": matches coverIgnore regex #", i, ": ", re.toString()].join(""));
        return fpath;
      }
    }

    if (instrumentedFiles[fpath] !== undefined) {
      dlog("Re-using already instrumented file at: " + instrumentedFiles[fpath]);
      return instrumentedFiles[fpath];
    }

    lines = ns.prepareCode(lines);
    var instrumented = [];
    var hasDescribe = false;
    var hasIt = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("describe(") == 0)
        hasDescribe = true;
      else if ((line.indexOf("it(") == 0) && hasDescribe) {  // this is a jasmine spec; abort instrumentation
        jlog("Not instrumenting " + fpath + ": looks like jasmine tests");
        return fpath;
      } else if (line.indexOf("var jasmine =") > -1) {
        jlog("Not instrumenting " + fpath + ": looks like jasmine base file");
        return fpath;
      }
      if (ns.coverableLine(line)) {
        var id = fpath.replace(/\\/g, "/");
        var coverCmd = "Jazzy.cover(\"" + id + "\"," + (i+1) + ")";
        var idx = line.indexOf("else");
        if (idx == 0) {
  // special case: short if / else. Shim cover into condition
          idx = line.indexOf("if");
          if (idx == -1) {
            instrumented.push(line + coverCmd + ";");
          } else {
            idx = line.indexOf("(", idx);
            var part1 = line.substr(0, idx);
            var part2 = line.substr(idx, line.length);
            idx = findEndOfCondition(part2);
            var part3 = part2.substr(idx, part2.length);
            part2 = part2.substr(0, idx);
            var newLine = [part1, "(", coverCmd, "&&", part2, ")", part3].join("");
            instrumented.push(newLine);
          }
        }
        else
          instrumented.push([coverCmd, "; ", line].join(""));
      }
      else
        instrumented.push(line);
    }
    
    var ret = writeLines(fpath, instrumented);
    instrumentedFiles[fpath] = ret;

    if (testInstrumentedFile(ret, fpath))
      return ret;
    failedInstrumentations.push(fpath);
    return fpath;
  };

  function findEndOfCondition(fragment) {
    var count = 0;
    var start = fragment.indexOf("(");
    for (var i = start; i < fragment.length; i++) {
      switch (fragment[i]) {
        case "(":
          count++;
          break;
        case ")":
          count--;
          break;
        default:
          continue;
      }
      if (count == 0) return i + 1;
    }
    return fragment.length;
  }

  function testInstrumentedFile(fpath, srcpath) {
    // tests if an instrumented file is OK for inclusion
    // -- if instrumentation causes brokenness, the original file is
    // used so that at least tests can be run.
    var testPage = ns.webpage.create();
    var works = true;
    testPage.onError = function(msg, trace) {
      console.log(msg);
      works = false;
    };
    testPage.injectJs(ns.findFile("jasmine.js"));
    for (var i = 0; i < ns.injectedScripts.length; i++)
      testPage.injectJs(ns.injectedScripts[i]); // may be required for this one to work
    testPage.injectJs(fpath);
    if (globalOptions.debug && globalOptions.debugCopyTo) {
      if (fs.isDirectory(globalOptions.debugCopyTo)) {
        var toDump = [srcpath, fpath];
        for (var i = 0; i < toDump.length; i++) {
          var parts = toDump[i].split("/");
          var dumpFile = [globalOptions.debugCopyTo, parts[parts.length-1]].join("/");
          if (fs.isFile(dumpFile))
            fs.remove(dumpFile);
          fs.copy(toDump[i], dumpFile);
        }
      }
    }
    if (!works) {
      console.log("Instrumentation on " + srcpath + " fails; no coverage will be done");
      instrumentedFiles[fpath] = null;
    }
    return works;
  }

  function writeLines(fpath, lines) {
    var ret = fpath.replace(/\.js$/, "") + "__instrumented.js";
    var fp = fs.open(ret, "w");
    fp.write(lines.join("\n"));
    fp.close();
    return ret;
  }

  ns.injectCoverageHelpers = function(page) {
    var result = [];
    result.push("var Jazzy = Jazzy || {};");
    result.push("(function(ns) {");
    result.push("var coverage = [];");
    result.push("ns.cover = function(fileName, line) {");
    result.push("coverage.push({file: fileName, line: line}); return true;");
    result.push("};");
    result.push("ns.clearCoverage = function() { coverage = []; };");
    result.push("ns.getCoverageData = function() { return coverage; };");
    result.push("})(Jazzy);");
    coverageFunctionsIncluded = true;
    var tmpFile = "jazzy.helpers.coverage.js";
    var fp = fs.open(tmpFile, "w");
    fp.write(result.join("\n"));
    fp.close();
    ns.injectJs(page, tmpFile);
  };

  function validInjectable(src) {
    var parts = src.split(".");
    if (parts[parts.length-1] != "js") {
      console.log("Not injecting: " + src + ": not a javascript file (if it is, please add the .js extension)");
      return false;
    }
    var agnostic = src.replace(/\\/g, "/");
    parts = agnostic.split("/");
    if (parts[parts.length-1] == "jasmine.js") {
      dlog("Not injecting: " + src + ": jasmine is included by jazzy already");
      return false;
    }
    parts = src.split("__");
    if ((parts.length == 2) && (parts[1] == "instrumented.js"))
      return false;
    return true;
  };

  function readLines(fpath) {
    var fp = fs.open(fpath, "r");
    if (fp === undefined)
      throw "Unable to open file at: " + fpath;
    var lines = fp.read().split("\n");
    fp.close();
    return lines;
  };

  var referenceRe = new RegExp("^\\s*///\\s*<reference path=\".*\"\\s*/>\\s*$");
  ns.injectReferences = function(page, fpath, lines, coverRefs) {
    fpath = fpath.replace(fs.separator, "/");
    var parts = fpath.split("/");
    var dirName = parts.slice(0, parts.length-1).join("/");
    if (dirName == "") dirName = ".";
    for (var i = 0; i < lines.length; i++) {
      if (referenceRe.test(lines[i])) {
        var l = lines[i].trim();
        var idx1 = l.indexOf("path=");
        idx1 = l.indexOf("\"", idx1);
        var idx2 = l.indexOf("\"", idx1 + 1);
        var fname = l.substr(idx1 + 1, idx2-idx1-1);
        fname = fs.absolute([dirName, fname].join("/"));
        dlog("Injecting referenced file: " + fname);
        ns.injectScript(page, fname, coverRefs);
      }
    }
  };

  ns.injectScript = function(page, src, settings) {
    var cover = (settings.cover == null) ? globalOptions.cover : settings.cover;
    var loadRefs = (settings.loadRefs == null) ? globalOptions.loadRefs : settings.loadRefs;
    var coverRefs = (settings.coverRefs == null) ? globalOptions.coverRefs : settings.coverRefs;
    if (!validInjectable(src)) return;
    var lines = readLines(src);
    if (loadRefs)
      ns.injectReferences(page, src, lines, coverRefs);
    if (cover) {
      dlog("instrumenting and injecting: " + src);
      var instrumented = ns.instrumentFile(src, lines);
      if (!ns.injectJs(page, instrumented))
        throw "Unable to include instrumented script at: " + instrumented;
    } else {
      dlog("injecting: " + src);
      if (!ns.injectJs(page, src))
        throw "Unable to include script at: " + src;
    }
  }

  ns.generateCoverageReport = function(data) {
    jlog("Generating coverage report");
    var fp = fs.open(globalOptions.coverageReport, "w");
    ns.startCoverageReport(fp);
    var keys = [];
    for (var f in instrumentedFiles) {
      if (instrumentedFiles[f] !== null)
        keys.push(f);
    }
    keys.sort();
    var commonPrefix = getCommonPrefix(keys);
    var shortKeys = [];
    for (var i = 0; i < keys.length; i++) {
      var shortKey = keys[i].substr(commonPrefix.length, keys[i].length);
      shortKeys.push(shortKey);
    }
    ns.startShell(fp, shortKeys);
    for (var i = 0; i < keys.length; i++) {
      ns.addReport(fp, keys[i], shortKeys[i], data);
    }
    ns.completeShell(fp);
    fp.close();
  };

  ns.startShell = function(fp, keys) {
    var w = fp.writeLine;
    w("<div>");
    w("<div class=\"navigation\">");

    for (var i = 0; i < keys.length; i++) {
      ns.addNav(fp, keys[i]);
    }
    w("</div>");
    w("<div class=\"reports\">");
  };

  function getCommonPrefix(items) {
    var common;
    var looking = true;
    var test = "";
    while (looking) {
      common = test;
      var testlen = common.length + 1;
      test = items[0].substr(0, testlen);
      for (var i = 0; i < items.length; i++) {
        if (items[i].indexOf(test) != 0) {
          looking = false;
        }
      }
    }
    return common;
  }

  ns.addNav = function(fp, key) {
    var w = fp.writeLine;
    w("<div class=\"navitem\">" + key + "</div>");
  };

  ns.completeShell = function(fp) {
    fp.writeLine("<div></div>");
  };

  var map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  };
  ns.htmlEscape = function(str) {
    for (var k in map) {
      str = str.replace(new RegExp(map[k], "g"), k);
      str = str.replace(new RegExp(k, "g"), map[k]);
    }
    return str;
  };

  ns.addReport = function(fp, key, shortKey, rawData) {
    var w = fp.writeLine;
    w("<div style=\"display: none\" id=\"" + shortKey + "\" class=\"report\">");
    w("<table>");
    jlog("  " + key);
    var data = ns.consolidateData(key, rawData);
    var lines = readLines(key);
    var coveredLines = 0;
    var contentLines = 0;
    for (var i = 0; i < lines.length; i++) {
      var coverable = ns.coverableLine(lines[i].trim());
      var className = "unknown";
      if (data[i+1] === undefined)
        className = (coverable) ? "notcovered" : "";
      else {
        var hits = data[i+1];
        className = "covered" + ns.threshold(hits, [1,5,10,25,50], "hotspot");
      }
      w("<tr><td>" + (i + 1) + "</td><td class=\"code " + className + "\">" + ns.htmlEscape(lines[i]) +"</td></tr>");
      if (!coverable) continue;
      contentLines++;
      if (className !== "notcovered") coveredLines++;
    }
    w("<span id=\"coverage%:" + shortKey + "\" style=\"display: none\" data-lines=\"" + lines.length + "\" data-content-lines=\"" + contentLines + "\" data-covered-lines=\"" + coveredLines + "\">");
    if (contentLines > 0)
      w(parseInt(Math.round((coveredLines * 100) / contentLines)) +"%");
    else
      w("0%");
    w("</span>");
    w("</table>");
    w("</div>");
  };

  ns.threshold = function(val, steps, outofboundVal) {
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] >= val)
        return steps[i];
    }
    return outofboundVal;
  };

  ns.consolidateData = function(key, data) {
    var ret = [];
    key = key.replace(/\\/g, "/");
    for (var i = 0; i < data.length; i++) {
      var el = data[i];
      if (el.file === key) {
        if (ret[el.line] === undefined)
          ret[el.line] = 1;
        else
          ret[el.line]++;
      }
    }
    return ret;
  };

  ns.startCoverageReport = function(fp) {
    var w = fp.writeLine;
    w("<html>");
    w("<meta charset=\"UTF-8\"/>");
    w("<head><title>Jazzy coverage report</title>");
    w("<style>");
    w("html, body { background-color: #EEEEEE; color: black;}");
    w(".code { white-space: pre;}");
    w(".notcovered { background-color: #FFAAAA;}");
    w(".covered1  { background-color: #CCFFCC;}");
    w(".covered5  { background-color: #AAFFAA;}");
    w(".covered10 { background-color: #88FF88;}");
    w(".covered25 { background-color: #66FF66;}");
    w(".covered50 { background-color: #44FF44;}");
    w(".selected { border: 1px solid black !important;}");
    w(".navitem { cursor: pointer; border: 1px solid transparent;}");
    w(".navigation { float: left; width: 25%; }");
    w(".reports { width: 74%; }");
    w(".reports > table,tr,td { margin: 0px; border: 0px; padding: 0px; }");
    w(".coveredhotspot   { background-color: #FFFF60;}");
    w("</style>");
    w("<scri" + "pt language=\"javasc" + "ript\" type=\"text/javas" + "cript\">");
    w(" function onLoad() {");
    w("  var navitems = document.getElementsByClassName(\"navitem\");");
    w("  for (var i = 0; i < navitems.length; i++) {");
    w("   navitems[i].onclick = (function(id) {return function() { showReport(id); }})(navitems[i].textContent)");
    w("  }");
    w("  var navitems = document.getElementsByClassName(\"navitem\");");
    w("  if (navitems.length)");
    w("   showReport(navitems[0].textContent);");
    w("  displayCoveragePercentages();");
    w(" }");
    w(" function showReport(name) {");
    w("  var reports = document.getElementsByClassName(\"report\");");
    w("  for (var i = 0; i < reports.length; i++) {")
    w("   reports[i].style.display = (reports[i].id.indexOf(name) == 0) ? \"\" : \"none\";");
    w("  }");
    w("  var navitems = document.getElementsByClassName(\"navitem\");");
    w("  for (var i = 0; i < navitems.length; i++) {");
    w("   navitems[i].className = (navitems[i].textContent.indexOf(name) == 0) ? \"navitem selected\" : \"navitem\";");
    w("  }");
    w(" }");
    w(" function displayCoveragePercentages() {");
    w("  var navitems = document.getElementsByClassName(\"navitem\");");
    w("  for (var i = 0; i < navitems.length; i++) {");
    w("   var percEl = document.getElementById(\"coverage%:\" + navitems[i].textContent.trim());");
    w("   if (percEl !== undefined) navitems[i].textContent += percEl.textContent;");
    w("  }");
    w(" }");
    w("window.onload = onLoad;");
    w("</scr" + "ipt>");
    w("<body><h2>Jazzy coverage report as at: " + ns.now() + "</h2>");
  };

  ns.now = function() {
    var now = new Date();
    return now.toDateString() + " " + now.toLocaleTimeString();
  };

  ns.dispose = function() {
    var coverHelper = "jazzy.helpers.coverage.js";
    if (fs.isFile(coverHelper))
      fs.remove(coverHelper);
    for (var k in instrumentedFiles) {
      var f = instrumentedFiles[k];
      if (fs.isFile(f))
        fs.remove(f);
    };
  };

  function showHelp() {
    var help = [
      "Usage: phantomjs " + fs.absolute(system.args[0]) + " [switches] <filespec>... {<filespec>}",
      "where switches are of:",
      "  --cover:             global flag for primary script coverage",
      "  --cover-ignore:      specify a regex to match for files not to bother covering",
      "  --cover-references:  global flag for reference coverage",
      "  --cover-report:      output file name for the coverage report (defaults to coverage.html)",
      "  --debug:             show more information whilst running",
      "  --load-references:   global flag to load references (see loadrefs spec part)",
      "  Switches are specified in the format {switch}={value}, for example:",
      "    --cover=true",
      "    --cover-report=SpecialReport.html",
      "and a <fileSpec> looks like:",
      "  {<switch>:{<switch>..}:path}",
      "  eg: cover:../../foo.js",
      "  available switches:",
      "    cover:     instruments and covers the file in the output report (experimental)",
      "    loadrefs:  loads files referenced with /// <reference...",
      "    coverrefs: covers referenced files too"
      ];
    console.log(help.join("\n"));
    ns.aborted = true;  // phantom.exit() is unreliable
  }

  var globalOptions = {
    cover: true,
    coverRefs: true,
    loadRefs: true,
    debug: false,
    coverIgnores: [],
    coverageReport: "coverage.html",
    debugCopyTo: "C:/tmp"
  };

  function grokBooleanSwitch(str) {
    var parts = str.split("=");
    if (parts.length == 1) return true;
    switch (parts[1].toLowerCase()) {
      case "yes":
      case "true":
      case "on":
        return true;
      case "no":
      case "false":
      case "off":
        return false;
    }
    console.log(["Unable to grok boolean from \"",
        parts[1].toLowerCase(),
        "\" (for switch: \"",
        str, "\", defaulting to TRUE"].join(""));
    return true;
  };

  function grokArg(str) {
    if (/--[a-zA-Z\-].*/.test(str)) {
      var parts = str.split("=");
      var value = null;
      var arg = parts[0].substr(2, parts[0].length);
      if (parts.length > 1)
        value = parts.slice(1, parts.length).join("=");
      switch (arg) {
        case "cover-references":
          globalOptions.coverRefs = grokBooleanSwitch(str);
          break;
        case "load-references":
          globalOptions.loadRefs = grokBooleanSwitch(str);
          break;
        case "cover":
          globalOptions.cover = grokBooleanSwitch(str);
          break;
        case "cover-ignore":
          var parts = str.split("=");
          if (parts.length == 1) {
            throw "--cover-ignore requires a regex pattern to match";
          }
          try {
            globalOptions.coverIgnores.push(new RegExp(value));
          } catch (e) {
            throw ["\"", re, "\" is not a valid regex. Try again."].join("");
          }
          break;
        case "cover-report":
          globalOptions.coverageReport = value;
          break;
        case "debug":
          globalOptions.debug = grokBooleanSwitch(str);
          break;
        case "help":
          showHelp();
          break;
        default:
          throw "Invalid or unrecognised argument: \"" + str + "\" (try --help for help)";
      }
      return null;
    }
    switch (str) {
      default:
        var ret = {
          cover: null,
          coverRefs: null,
          inc: null,
          loadRefs: null
        };
        var parts = str.split(":");
        if (parts.indexOf("cover") > -1)
          ret.cover = true;
        if (parts.indexOf("loadrefs") > -1)
          ret.loadRefs = true;
        if (parts.indexOf("coverrefs") > -1)
          ret.coverRefs = true;

        for (var i = 0; i < parts.length; i++) {
          if (fs.isReadable(parts[i])) {
            ret.inc = parts[i];
            break;
          }
        }
        return ret;
    }
  };

  ns.setupEnvironment = function(page) {
    // get args
    var args = [];
    for (var i = 0; i < system.args.length; i++) {
      var arg = grokArg(system.args[i]);
      if (arg != null)
        args.push(arg);
    }
    // include jasmine & console reporter
    page.injectJs(ns.findFile("jasmine.js"));
    // include files under test
    for (var i = 1; i < args.length; i++) {
      var arg = args[i];
      if (arg.inc == null) {
        jlog("ERROR: Unable to find file or dir in argument: " + system.args[i]);
        continue;
      }
      if (fs.isDirectory(arg.inc)) {
        var items = ns.ls_r(arg.inc);
        for (var i = 0; i < items.length; i++) {
          ns.injectScript(page, items[i], arg);
        }
      }
      else {
        ns.injectScript(page, arg.inc, arg);
      }
    }
    // in the rare case of instrumenting jasmine itself, you would need extensions to happen
    // later... So this is actually an edge case, but meh.
    page.injectJs(ns.findFile("jasmine.console.reporter.js"));
  };

  var startMarker = ":::STARTED:::";
  var endMarker = ":::FINISHED:::";
  ns.runPage = function(page) {
    jlog("Tests start...");
    var i = page.evaluate(function(s, e) {
      Jazzy.clearCoverage();
      var jasmineEnv = jasmine.getEnv();
      var consoleReporter = new jasmine.JazzyConsoleReporter(s, e);
      jasmineEnv.addReporter(consoleReporter);
      jasmineEnv.execute();
    }, startMarker, endMarker);
  };

  ns.waitForTests = function(onComplete) {
    var waited = 0;
    window.setTimeout(function testRunning() {
      if (ns.running === true) {
        window.setTimeout(testRunning, 100);
      } else if (ns.running === false) {
        onComplete();
        jlog("Exiting...");
        phantom.exit();
      } else {
        if (++waited > 100) {
          jlog("waited > 10 seconds for tests to start; don't think it's going to happen");
          phantom.exit();
        }
      }
    }, 100);
  };

  ns.webpage = require("webpage");
  ns.createPage = function() {
    var page = ns.webpage.create();
    page.onError = function(msg, trace) {
      console.log(msg);
      trace.forEach(function(item) {
        console.log("  ", item.file, ":", item.line);
      });
    };
    page.onConsoleMessage = function(msg, lineNum, sourceId) {
      if (msg == endMarker) {
        ns.running = false;
      } else if (msg == startMarker) {
        ns.running = true;
      }
      else {
        if (sourceId !== undefined) {
          msg += " (" + sourceId;
          if (lineNum !== undefined)
            msg += ":" + lineNum;
          msg += ")";
        }
        console.log(">> " + msg);
      }
    };
    //page.onClosing = function(page) {
    //  console.log("page closing!");
    //};
    return page;
  };

  ns.run = function() {
    var page;
    if (system.args.length <= 1) {
      jlog("Please supply the name of at least javascript file to load");
      ns.running = false;
    } else {
      page = ns.createPage();
      ns.injectCoverageHelpers(page);
      ns.setupEnvironment(page);
      if (ns.aborted)
        ns.running = false;
      else
        ns.runPage(page);
    }
    if (ns.aborted)
      ns.waitForTests(function() {});
    else
    ns.waitForTests(function() {
      ns.dispose();
      try {
      var coverageData = page.evaluate(function() {
        try {
          return Jazzy.getCoverageData();
        } catch (e) {
          console.log("Coverage data fetch fails: " + e)
          return null;
        }
      });
      if (coverageData)
        ns.generateCoverageReport(coverageData);
      else
        jlog("Unable to get coverage data from page ):");
      } catch (e) {
        jlog("Unable to get coverage data from page (evaluate call failed)");
      }
    });
  };

})(Jazzy);

Jazzy.run();

