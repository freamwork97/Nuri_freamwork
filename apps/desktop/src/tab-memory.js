// A page left open while the app sits in the tray can grow without end (measured: the Google home
// page, 2 GB a day of native memory). While nobody looks, tabs over the limit are reloaded.

/** The tabs whose page process uses more than limitMb. Metrics are app.getAppMetrics(); sizes in KB. */
function heavyTabs(tabs, metrics, limitMb) {
  const used = new Map(metrics.map((m) => [m.pid, m.memory.privateBytes ?? m.memory.workingSetSize]));
  return tabs.filter((t) => !t.mirror && used.get(t.view.webContents.getOSProcessId()) > limitMb * 1024);
}

module.exports = { heavyTabs };
