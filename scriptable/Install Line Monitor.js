// Install / update Line Monitor in Scriptable.
// Paste this into a new Scriptable script, run it once, and "Line Monitor" appears in your script list.
// Run it again any time to update to the latest version from GitHub.

const SOURCE = "https://raw.githubusercontent.com/YabbaYabbaYabba/pure-line-monitor/main/scriptable/Line%20Monitor.js";

const req = new Request(SOURCE);
let code = "";
try { code = await req.loadString(); } catch (e) { code = ""; }
const status = req.response ? req.response.statusCode : 0;
const alert = new Alert();
if (status !== 200 || !code.includes("Line Monitor for iPhone")) {
  alert.title = "Download failed";
  alert.message = `GitHub answered ${status || "nothing"}. Check the internet connection and that the repository is public.`;
} else {
  let fm = FileManager.local();
  try {
    const icloud = FileManager.iCloud();
    if (module.filename.startsWith(icloud.documentsDirectory())) fm = icloud; // scripts kept in iCloud
  } catch (e) { /* iCloud off: keep local */ }
  fm.writeString(fm.joinPath(fm.documentsDirectory(), "Line Monitor.js"), code);
  alert.title = "Line Monitor installed";
  alert.message = "Close this and open \"Line Monitor\" from your Scriptable scripts. Run this installer again any time to update.";
}
alert.addAction("OK");
await alert.present();
Script.complete();
