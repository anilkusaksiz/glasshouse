/**
 * test/test-dashboard-port.js - The dashboard port from the Server tab, and
 * the TV apps that open the dashboard following it
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var controls = require('../server/lib/controls');
var apps = require('../server/lib/apps');

console.log('Running test-dashboard-port.js ...');

function freePort(cb) {
  var s = net.createServer();
  s.listen(0, function () {
    var p = s.address().port;
    s.close(function () { cb(p); });
  });
}

function setup(config) {
  var h = { saved: [], restarts: 0 };
  controls.init({
    config: config,
    writeSettings: function (patch, cb) { h.saved.push(patch); cb(null); },
    restartSelf: function () { h.restarts++; return true; },
    updateSummary: function () { return { ok: true }; }
  });
  return h;
}

function refused(value, config, done) {
  var h = setup(config);
  controls.doControl('setDashboardPort', value, function (res) {
    assert.strictEqual(res.ok, false, String(value) + ' is refused');
    assert.ok(/1024 to 65533/.test(res.error), String(value) + ': ' + res.error);
    assert.strictEqual(h.saved.length, 0, String(value) + ' is not saved');
    done();
  });
}

function testValidation(done) {
  var bad = ['', 'abc', '80', '1023', '65534', '9998', '8080.5', '-8081', null, undefined];
  var i = 0;
  (function next() {
    if (i === bad.length) { console.log('  ✓ ports outside 1024-65533, 9998 and non-numbers are refused unsaved'); return done(); }
    refused(bad[i++], { allowControl: true, port: 8080 }, next);
  })();
}

function testInUse(done) {
  var holder = net.createServer();
  holder.listen(0, function () {
    var taken = holder.address().port;
    var h = setup({ allowControl: true, port: 8080 });
    controls.doControl('setDashboardPort', String(taken), function (res) {
      holder.close();
      assert.strictEqual(res.ok, false);
      assert.ok(/already using/.test(res.error), res.error);
      assert.strictEqual(h.saved.length, 0, 'a port in use is not saved');
      console.log('  ✓ a port another service holds is refused unsaved');
      done();
    });
  });
}

function testSaved(done) {
  freePort(function (port) {
    port = Math.max(1024, Math.min(port, 65533));
    var h = setup({ allowControl: true, port: 8080 });
    controls.doControl('setDashboardPort', String(port), function (res) {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.restarting, true);
      assert.strictEqual(res.newPort, port);
      assert.deepEqual(h.saved, [{ port: port }]);
      assert.strictEqual(h.restarts, 0, 'the answer goes out before the restart');
      setTimeout(function () {
        assert.strictEqual(h.restarts, 1, 'restarted to bind the new port');
        console.log('  ✓ a free port is saved, the answer announces the restart, then the server restarts');
        done();
      }, 900);
    });
  });
}

function testUnchanged(done) {
  var h = setup({ allowControl: true, port: 8081 });
  controls.doControl('setDashboardPort', '8081', function (res) {
    assert.strictEqual(res.ok, true);
    assert.ok(!res.restarting);
    assert.strictEqual(h.saved.length, 0);
    console.log('  ✓ the port already in use by the dashboard itself is a no-op');
    done();
  });
}

function testLauncherSync() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  var page = "<script>\n  var PORT = 8080;                // tvweb:port\n  var BASE = 'http://localhost:' + PORT;\n</script>\n";
  var ids = ['com.tvweb.dashboard', 'io.github.rorygallagher2024.lg-webos-dashboard'];
  ids.forEach(function (id) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'index.html'), page);
  });

  assert.deepEqual(apps.syncLauncherPort(8080, root), [], 'already right: nothing written');
  assert.deepEqual(apps.syncLauncherPort(8081, root), ids);
  ids.forEach(function (id) {
    var html = fs.readFileSync(path.join(root, id, 'index.html'), 'utf8');
    assert.ok(html.indexOf('var PORT = 8081;') !== -1, id);
    assert.ok(html.indexOf('// tvweb:port') !== -1, 'the marker survives');
    assert.ok(html.indexOf("'http://localhost:' + PORT") !== -1, 'the rest is untouched');
  });
  assert.deepEqual(apps.syncLauncherPort(8081, root), [], 'idempotent');
  assert.deepEqual(apps.syncLauncherPort(8080, root), ids, 'back to the default');

  assert.deepEqual(apps.syncLauncherPort('bogus', root), []);
  assert.deepEqual(apps.syncLauncherPort(70000, root), []);
  assert.ok(fs.readFileSync(path.join(root, ids[0], 'index.html'), 'utf8').indexOf('var PORT = 8080;') !== -1);

  fs.unlinkSync(path.join(root, ids[1], 'index.html'));
  assert.deepEqual(apps.syncLauncherPort(8082, root), [ids[0]], 'an app that is not installed is skipped');
  assert.deepEqual(apps.syncLauncherPort(8082, path.join(root, 'missing')), [], 'no apps directory at all');

  fs.writeFileSync(path.join(root, ids[0], 'index.html'), '<p>an older page with no marker</p>');
  assert.deepEqual(apps.syncLauncherPort(8083, root), [], 'a page without the marker is left alone');
  console.log('  ✓ installed launcher pages follow the port, idempotently, and absent or unmarked ones are skipped');
}

function testShippedLaunchersCarryMarker() {
  ['../server/assets/dashboard-app/index.html', '../hbc/app/index.html'].forEach(function (rel) {
    var html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(/var PORT = 8080;\s*\/\/ tvweb:port/.test(html), rel + ' has the marker line at the default port');
    assert.ok(!/localhost:8080/.test(html), rel + ' does not hard-code the port elsewhere');
  });
  console.log('  ✓ both shipped launcher pages carry the marker and default to 8080');
}

testLauncherSync();
testShippedLaunchersCarryMarker();
testValidation(function () {
  testInUse(function () {
    testSaved(function () {
      testUnchanged(function () {
        console.log('test-dashboard-port.js passed');
        process.exit(0);
      });
    });
  });
});
