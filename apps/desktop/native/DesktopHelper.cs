// ANB desktop helper: lets the agent see and operate the Windows desktop ("computer use").
// Compile with .NET Framework csc.exe (C# 5 syntax only) — see native/build.cmd.
//
// Protocol: one JSON request per line on stdin -> one JSON response per line on stdout.
//   {"id":1,"cmd":"observe","maxWidth":1400}  ->  {"id":1,"ok":true,...}
// Commands: ping, observe, windows, foreground, folders, setvalue, readtext, filedialog, close, focus, mouse, drag, scroll, type, key, launch, at, cursor.
// Background mode (no real mouse/keyboard, no focus change): wobserve, bgclick, bgtype, bgkey (also key combinations), bgscroll, bgdrag, bgplace.
// All coordinates are physical screen pixels (the process is per-monitor DPI aware).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace AnbDesktopHelper
{
    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        [MTAThread]
        static void Main(string[] argv)
        {
            Native.EnableDpiAwareness();
            // --listen <port> <tokenFile> [bindAddress]: serve the same protocol over TCP (used inside the Windows
            // Sandbox "AI 작업 PC"). The first line from a client must be {"token":"..."}.
            if (argv.Length >= 3 && argv[0] == "--listen")
            {
                Listen(int.Parse(argv[1]), argv[2], argv.Length >= 4 ? System.Net.IPAddress.Parse(argv[3]) : System.Net.IPAddress.Any);
                return;
            }
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            Serve(input, output);
        }

        static void Listen(int port, string tokenFile, System.Net.IPAddress bind)
        {
            var listener = new System.Net.Sockets.TcpListener(bind, port);
            listener.Start();
            while (true)
            {
                var client = listener.AcceptTcpClient();
                try
                {
                    client.NoDelay = true;
                    var stream = client.GetStream();
                    var input = new StreamReader(stream, new UTF8Encoding(false));
                    var output = new StreamWriter(stream, new UTF8Encoding(false));
                    output.AutoFlush = true;
                    string expected = File.ReadAllText(tokenFile).Trim();
                    var hello = Json.Deserialize<Dictionary<string, object>>(input.ReadLine() ?? "{}");
                    if (expected.Length < 16 || Args.Str(hello, "token", "") != expected) { client.Close(); continue; }
                    Serve(input, output);
                }
                catch (Exception) { }
                finally { client.Close(); }
            }
        }

        static void Serve(TextReader input, TextWriter output)
        {
            output.WriteLine(Json.Serialize(new Dictionary<string, object> { { "ready", true }, { "version", 1 } }));

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                object id = null;
                Dictionary<string, object> res;
                try
                {
                    var req = Json.Deserialize<Dictionary<string, object>>(line);
                    if (req.ContainsKey("id")) id = req["id"];
                    res = Commands.Run(req);
                    res["ok"] = true;
                }
                catch (Exception e)
                {
                    res = new Dictionary<string, object>();
                    res["ok"] = false;
                    res["error"] = e.Message;
                }
                res["id"] = id;
                output.WriteLine(Json.Serialize(res));
            }
        }
    }

    static class Args
    {
        public static string Str(Dictionary<string, object> d, string k, string def)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : def;
        }
        public static int Int(Dictionary<string, object> d, string k, int def)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return def;
            return (int)Math.Round(Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture));
        }
        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            return d.TryGetValue(k, out v) && v is bool ? (bool)v : def;
        }
        public static int NeedInt(Dictionary<string, object> d, string k)
        {
            if (!d.ContainsKey(k) || d[k] == null) throw new Exception("missing '" + k + "'");
            return Int(d, k, 0);
        }
    }

    static class Commands
    {
        public static Dictionary<string, object> Run(Dictionary<string, object> req)
        {
            string cmd = Args.Str(req, "cmd", "");
            var res = new Dictionary<string, object>();
            switch (cmd)
            {
                case "ping":
                    res["pong"] = true;
                    break;
                case "observe":
                    Observe(req, res);
                    break;
                case "windows":
                    res["windows"] = Windows.List();
                    break;
                case "focus":
                    res["focused"] = Windows.Focus(new IntPtr(Convert.ToInt64(req["hwnd"])));
                    break;
                case "mouse":
                    Input.Mouse(Args.Str(req, "action", "click"), Args.NeedInt(req, "x"), Args.NeedInt(req, "y"), Args.Str(req, "button", "left"));
                    break;
                case "drag":
                    Input.Drag(Args.NeedInt(req, "x1"), Args.NeedInt(req, "y1"), Args.NeedInt(req, "x2"), Args.NeedInt(req, "y2"));
                    break;
                case "scroll":
                    Input.Scroll(Args.NeedInt(req, "x"), Args.NeedInt(req, "y"), Args.Int(req, "amount", -5), Args.Bool(req, "horizontal", false));
                    break;
                case "type":
                    res["typed"] = Input.TypeText(Args.Str(req, "text", ""), GuardOf(req));
                    break;
                case "key":
                    Input.EnsureForeground(GuardOf(req));
                    Input.KeyCombo(Args.Str(req, "keys", ""), Math.Max(1, Math.Min(50, Args.Int(req, "repeat", 1))));
                    break;
                case "launch":
                    var psi = new ProcessStartInfo(Args.Str(req, "target", "")) { UseShellExecute = true };
                    Process.Start(psi);
                    break;
                case "setvalue":
                    res["value"] = UiTree.SetValueAt(Args.NeedInt(req, "x"), Args.NeedInt(req, "y"), Args.Str(req, "text", ""), 3000);
                    break;
                case "at":
                    res["element"] = UiTree.At(Args.NeedInt(req, "x"), Args.NeedInt(req, "y"), 1500);
                    break;
                case "readtext":
                {
                    // Text of a window (hwnd, default: foreground) or of the element at x,y. Read-only.
                    IntPtr h = GuardOf(req);
                    if (h == IntPtr.Zero) h = Native.GetForegroundWindow();
                    res["text"] = UiTree.ReadText(h, Args.Int(req, "x", -1), Args.Int(req, "y", -1),
                        Math.Max(1000, Math.Min(200000, Args.Int(req, "max", 40000))), 8000);
                    res["window"] = Windows.Describe(h);
                    break;
                }
                case "filedialog":
                {
                    // Fills a standard Open/Save dialog (class #32770) with a path and presses its OK button.
                    IntPtr h = GuardOf(req);
                    if (h == IntPtr.Zero) throw new Exception("missing 'hwnd'");
                    var r = UiTree.FillFileDialog(h, Args.Str(req, "path", ""), 5000);
                    foreach (var kv in r) res[kv.Key] = kv.Value;
                    break;
                }
                case "close":
                    // Polite close (WM_CLOSE): the app may still ask to save. No keystrokes involved.
                    res["posted"] = Native.PostMessage(new IntPtr(Convert.ToInt64(req["hwnd"])), 0x0010, IntPtr.Zero, IntPtr.Zero);
                    break;
                case "foreground":
                    res["window"] = Windows.Describe(Native.GetForegroundWindow());
                    break;
                case "folders":
                    res["desktop"] = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    res["documents"] = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                    res["pictures"] = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                    res["videos"] = Environment.GetFolderPath(Environment.SpecialFolder.MyVideos);
                    res["home"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    res["downloads"] = Native.KnownFolder(new Guid("374DE290-123F-4565-9164-39C4925E467B"));
                    break;
                case "wobserve":
                    Background.Observe(req, res);
                    break;
                case "bgclick":
                    res["method"] = Background.Click(Args.Str(req, "el", ""), Args.Int(req, "x", Background.NoPos), Args.Int(req, "y", Background.NoPos), Args.Bool(req, "double", false), Args.Bool(req, "right", false));
                    break;
                case "bgtype":
                    res["method"] = Background.Type(Args.Str(req, "el", ""), GuardOf(req), Args.Str(req, "text", ""), Args.Bool(req, "clear", false));
                    break;
                case "bgkey":
                    res["method"] = Background.Key(GuardOf(req), Args.Str(req, "keys", ""), Math.Max(1, Math.Min(50, Args.Int(req, "repeat", 1))));
                    break;
                case "bgdrag":
                    res["method"] = Background.Drag(Args.Str(req, "el", ""), Args.Int(req, "x1", Background.NoPos), Args.Int(req, "y1", Background.NoPos), Args.Int(req, "x2", Background.NoPos), Args.Int(req, "y2", Background.NoPos));
                    break;
                case "bgscroll":
                    res["method"] = Background.Scroll(Args.Str(req, "el", ""), Args.Int(req, "x", Background.NoPos), Args.Int(req, "y", Background.NoPos), Args.Int(req, "amount", -5), Args.Bool(req, "horizontal", false));
                    break;
                case "bgplace":
                    res["placed"] = Background.Place(GuardOf(req), new IntPtr(Convert.ToInt64(req.ContainsKey("restore") && req["restore"] != null ? req["restore"] : 0)));
                    break;
                case "cursor":
                    Native.POINT p;
                    Native.GetCursorPos(out p);
                    res["x"] = p.X;
                    res["y"] = p.Y;
                    break;
                default:
                    throw new Exception("unknown cmd '" + cmd + "'");
            }
            return res;
        }

        // Optional "hwnd": keystrokes are only sent while that window has focus.
        static IntPtr GuardOf(Dictionary<string, object> req)
        {
            object v;
            if (!req.TryGetValue("hwnd", out v) || v == null) return IntPtr.Zero;
            return new IntPtr(Convert.ToInt64(v));
        }

        // Screenshot of one monitor + interactive UI elements of the foreground window (and taskbar),
        // with numbered marks drawn on the image so a vision model can refer to them.
        static void Observe(Dictionary<string, object> req, Dictionary<string, object> res)
        {
            int maxWidth = Math.Max(640, Math.Min(2560, Args.Int(req, "maxWidth", 1400)));
            int quality = Math.Max(30, Math.Min(95, Args.Int(req, "quality", 70)));
            bool marks = Args.Bool(req, "marks", true);
            int maxElements = Math.Max(0, Math.Min(300, Args.Int(req, "maxElements", 120)));

            IntPtr fg = Native.GetForegroundWindow();
            Screen screen = fg != IntPtr.Zero ? Screen.FromHandle(fg) : Screen.PrimaryScreen;
            if (Args.Str(req, "screen", "") == "primary") screen = Screen.PrimaryScreen;
            Rectangle sb = screen.Bounds;

            var elements = maxElements > 0 ? UiTree.Collect(fg, sb, maxElements, 2500) : new List<Dictionary<string, object>>();

            using (var shot = new Bitmap(sb.Width, sb.Height, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(shot))
                {
                    g.CopyFromScreen(sb.X, sb.Y, 0, 0, sb.Size, CopyPixelOperation.SourceCopy);
                    DrawCursor(g, sb);
                    if (marks) DrawMarks(g, sb, elements);
                }
                double scale = Math.Min(1.0, (double)maxWidth / sb.Width);
                int w = (int)Math.Round(sb.Width * scale), h = (int)Math.Round(sb.Height * scale);
                using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(small))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(shot, 0, 0, w, h);
                    }
                    res["image"] = Jpeg(small, quality);
                }
                res["width"] = w;
                res["height"] = h;
                res["scale"] = scale;
            }

            res["screen"] = new Dictionary<string, object> { { "x", sb.X }, { "y", sb.Y }, { "width", sb.Width }, { "height", sb.Height }, { "primary", screen.Primary } };
            res["screens"] = Screen.AllScreens.Length;
            res["foreground"] = Windows.Describe(fg);
            res["elements"] = elements;
            Native.POINT cp;
            Native.GetCursorPos(out cp);
            res["cursor"] = new Dictionary<string, object> { { "x", cp.X }, { "y", cp.Y } };
        }

        static void DrawCursor(Graphics g, Rectangle sb)
        {
            Native.POINT p;
            if (!Native.GetCursorPos(out p)) return;
            int x = p.X - sb.X, y = p.Y - sb.Y;
            using (var pen = new Pen(Color.FromArgb(220, 220, 38, 38), 2))
            {
                g.DrawLine(pen, x - 9, y, x + 9, y);
                g.DrawLine(pen, x, y - 9, x, y + 9);
            }
        }

        internal static void DrawMarks(Graphics g, Rectangle sb, List<Dictionary<string, object>> elements)
        {
            using (var pen = new Pen(Color.FromArgb(230, 234, 88, 12), 2))
            using (var bg = new SolidBrush(Color.FromArgb(235, 234, 88, 12)))
            using (var font = new Font("Consolas", 11, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                foreach (var e in elements)
                {
                    int x = (int)e["x"] - sb.X, y = (int)e["y"] - sb.Y, w = (int)e["w"], h = (int)e["h"];
                    // Big containers (documents, panes) only get a label, not a box over everything.
                    if ((long)w * h < (long)sb.Width * sb.Height / 4) g.DrawRectangle(pen, x, y, w, h);
                    string label = (string)e["id"];
                    SizeF size = g.MeasureString(label, font);
                    int ly = y - (int)size.Height - 1;
                    if (ly < 0) ly = y + 1;
                    g.FillRectangle(bg, x, ly, size.Width + 2, size.Height);
                    g.DrawString(label, font, Brushes.White, x + 1, ly);
                }
            }
        }

        internal static string Jpeg(Bitmap bmp, int quality)
        {
            ImageCodecInfo codec = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
            var ps = new EncoderParameters(1);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, codec, ps);
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }

    // Background computer use: works on ONE target window without the real mouse/keyboard and
    // without changing focus, so the user can keep working. The window may be covered by others:
    // it is captured with PrintWindow, and actions go through UI Automation patterns or messages
    // posted to that window (never SendInput).
    static class Background
    {
        static readonly List<AutomationElement> Live = new List<AutomationElement>();
        static IntPtr target = IntPtr.Zero;
        const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_LBUTTONDBLCLK = 0x0203,
            WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205, WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E,
            WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, EM_SETSEL = 0x00B1;

        public static void Observe(Dictionary<string, object> req, Dictionary<string, object> res)
        {
            IntPtr h = new IntPtr(Convert.ToInt64(req["hwnd"]));
            if (!Native.IsWindow(h)) throw new Exception("window not found (it was closed)");
            if (Native.IsIconic(h)) { Native.ShowWindow(h, 4); Thread.Sleep(300); } // SW_SHOWNOACTIVATE: minimized windows can't be captured
            int maxWidth = Math.Max(640, Math.Min(2560, Args.Int(req, "maxWidth", 1400)));
            int quality = Math.Max(30, Math.Min(95, Args.Int(req, "quality", 70)));
            int maxElements = Math.Max(0, Math.Min(300, Args.Int(req, "maxElements", 150)));
            Native.RECT r;
            Native.GetWindowRect(h, out r);
            var wb = new Rectangle(r.Left, r.Top, Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top));

            var found = new List<Dictionary<string, object>>();
            var live = new List<AutomationElement>();
            var worker = new Thread(() => { try { UiTree.CollectFrom(h, wb, found, maxElements, "window", live); } catch (Exception) { } });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(3500);
            List<Dictionary<string, object>> elements;
            lock (found)
            {
                elements = new List<Dictionary<string, object>>(found);
                lock (Live) { Live.Clear(); Live.AddRange(live.GetRange(0, Math.Min(live.Count, elements.Count))); }
            }
            for (int i = 0; i < elements.Count; i++) elements[i]["id"] = "d" + (i + 1);
            target = h;

            using (var shot = new Bitmap(wb.Width, wb.Height, PixelFormat.Format32bppArgb))
            {
                // DPI-unaware apps are drawn at their logical size by PrintWindow (smaller than the
                // physical window on scaled screens): capture that and stretch it to physical pixels,
                // so element boxes (physical coordinates) line up with the picture.
                double ratio = 1.0;
                try
                {
                    uint wdpi = Native.GetDpiForWindow(h), mdx, mdy;
                    if (wdpi > 0 && Native.GetDpiForMonitor(Native.MonitorFromWindow(h, 2), 0, out mdx, out mdy) == 0 && mdx > 0 && wdpi < mdx) ratio = (double)wdpi / mdx;
                }
                catch (Exception) { }
                bool ok;
                using (var raw = new Bitmap(wb.Width, wb.Height, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(raw))
                    {
                        g.Clear(Color.White);
                        IntPtr dc = g.GetHdc();
                        ok = Native.PrintWindow(h, dc, 2); // PW_RENDERFULLCONTENT: also covered windows
                        g.ReleaseHdc(dc);
                    }
                    using (var g = Graphics.FromImage(shot))
                    {
                        if (ratio < 0.99)
                        {
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.DrawImage(raw, new Rectangle(0, 0, wb.Width, wb.Height), new Rectangle(0, 0, (int)Math.Round(wb.Width * ratio), (int)Math.Round(wb.Height * ratio)), GraphicsUnit.Pixel);
                        }
                        else g.DrawImage(raw, 0, 0);
                        if (Args.Bool(req, "marks", true)) Commands.DrawMarks(g, wb, elements);
                    }
                }
                res["captured"] = ok;
                double scale = Math.Min(1.0, (double)maxWidth / wb.Width);
                int w = Math.Max(1, (int)Math.Round(wb.Width * scale)), hh = Math.Max(1, (int)Math.Round(wb.Height * scale));
                using (var small = new Bitmap(w, hh, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(small))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(shot, 0, 0, w, hh);
                    }
                    res["image"] = Commands.Jpeg(small, quality);
                }
                res["width"] = w;
                res["height"] = hh;
                res["scale"] = scale;
            }
            res["screen"] = new Dictionary<string, object> { { "x", wb.X }, { "y", wb.Y }, { "width", wb.Width }, { "height", wb.Height }, { "primary", true } };
            res["screens"] = 1;
            res["foreground"] = Windows.Describe(h); // the TARGET window (not the user's foreground)
            res["userForeground"] = Windows.Describe(Native.GetForegroundWindow());
            res["elements"] = elements;
        }

        static AutomationElement ById(string id)
        {
            int n;
            if (string.IsNullOrEmpty(id) || id[0] != 'd' || !int.TryParse(id.Substring(1), out n)) return null;
            lock (Live) return n >= 1 && n <= Live.Count ? Live[n - 1] : null;
        }

        static AutomationElement SmallestAt(int x, int y)
        {
            AutomationElement best = null;
            double bestArea = double.MaxValue;
            List<AutomationElement> copy;
            lock (Live) copy = new List<AutomationElement>(Live);
            foreach (var e in copy)
            {
                try
                {
                    var r = (System.Windows.Rect)e.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
                    if (r.IsEmpty || !r.Contains(new System.Windows.Point(x, y))) continue;
                    double a = r.Width * r.Height;
                    var ct = (ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
                    if (ct == ControlType.Document || ct == ControlType.MenuBar) a = a * 100; // containers lose to controls inside them
                    if (a < bestArea) { bestArea = a; best = e; }
                }
                catch (Exception) { }
            }
            return best;
        }

        static T OnThread<T>(Func<T> f, int timeoutMs)
        {
            T result = default(T);
            Exception error = null;
            var t = new Thread(() => { try { result = f(); } catch (Exception e) { error = e; } });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(timeoutMs)) throw new Exception("the app did not respond in time");
            if (error != null) throw error;
            return result;
        }

        static IntPtr MakeLParam(int lo, int hi) { return new IntPtr((hi << 16) | (lo & 0xFFFF)); }

        // Deepest visible child window under a screen point, with the point in its client coordinates.
        static IntPtr ChildAt(IntPtr top, int sx, int sy, out Native.POINT client)
        {
            IntPtr cur = top;
            client = new Native.POINT { X = sx, Y = sy };
            Native.ScreenToClient(cur, ref client);
            for (int i = 0; i < 20; i++)
            {
                IntPtr child = Native.ChildWindowFromPointEx(cur, client, 0x0001 | 0x0002); // skip invisible/disabled
                if (child == IntPtr.Zero || child == cur) break;
                cur = child;
                client = new Native.POINT { X = sx, Y = sy };
                Native.ScreenToClient(cur, ref client);
            }
            return cur;
        }

        static string PostClick(int sx, int sy, bool dbl, bool right)
        {
            if (target == IntPtr.Zero || !Native.IsWindow(target)) throw new Exception("no target window: observe it first");
            Native.POINT c;
            IntPtr h = ChildAt(target, sx, sy, out c);
            IntPtr lp = MakeLParam(c.X, c.Y);
            uint down = right ? WM_RBUTTONDOWN : WM_LBUTTONDOWN, up = right ? WM_RBUTTONUP : WM_LBUTTONUP;
            IntPtr mk = new IntPtr(right ? 0x0002 : 0x0001);
            Native.PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
            Native.PostMessage(h, down, mk, lp);
            Native.PostMessage(h, up, IntPtr.Zero, lp);
            if (dbl)
            {
                Native.PostMessage(h, WM_LBUTTONDBLCLK, mk, lp);
                Native.PostMessage(h, up, IntPtr.Zero, lp);
            }
            return "posted " + (dbl ? "double-click" : right ? "right-click" : "click") + " message";
        }

        public static string Click(string id, int x, int y, bool dbl, bool right)
        {
            return Guarded(() => ClickInner(id, x, y, dbl, right));
        }

        // If an action still brought the target app to the front, put it back behind right away
        // and give the focus back to the window the user was using.
        static string Guarded(Func<string> action)
        {
            IntPtr before = Native.GetForegroundWindow();
            string r = action();
            Thread.Sleep(120);
            IntPtr now = Native.GetForegroundWindow();
            if (before != IntPtr.Zero && now != before && target != IntPtr.Zero && SameProcess(now, target))
            {
                Native.SetWindowPos(now, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
                Windows.Focus(before);
                r += "; the app came to the front, so it was moved back behind the user's window";
            }
            return r;
        }

        static bool SameProcess(IntPtr a, IntPtr b)
        {
            uint pa, pb;
            Native.GetWindowThreadProcessId(a, out pa);
            Native.GetWindowThreadProcessId(b, out pb);
            return pa == pb && pa != 0;
        }

        static string ClickInner(string id, int x, int y, bool dbl, bool right)
        {
            var el = ById(id);
            if (el == null)
            {
                if (x == NoPos || y == NoPos) throw new Exception("unknown element id (ids change every turn)");
                // A point inside a known element: use that element (patterns work where posted clicks don't).
                el = SmallestAt(x, y);
                if (el == null) return PostClick(x, y, dbl, right);
            }
            // Classic controls with their own window (Win32 / WinForms): message them directly.
            // UIA's client-side proxies would call SetForegroundWindow and pull the app to the front.
            string native = right ? null : NativeClick(el, dbl);
            if (native != null) return native;
            string viaPattern = right ? null : OnThread(() =>
            {
                object p;
                if (dbl)
                {
                    // Opening an item: select it, then invoke (file lists, tree items) if it can be invoked.
                    if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) ((SelectionItemPattern)p).Select();
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked (open)"; }
                    return null;
                }
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked"; }
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggled"; }
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
                {
                    var ec = (ExpandCollapsePattern)p;
                    if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); else ec.Expand();
                    return "expanded/collapsed";
                }
                return null;
            }, 5000);
            if (viaPattern != null) return viaPattern;
            var r = OnThread(() => el.Current.BoundingRectangle, 3000);
            if (r.IsEmpty) throw new Exception("element has no position");
            return PostClick((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), dbl, right);
        }

        const uint WM_COMMAND = 0x0111, BM_CLICK = 0x00F5, WM_SETTEXT = 0x000C, EM_REPLACESEL = 0x00C2, BN_CLICKED = 0;

        static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            Native.GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static IntPtr OwnHandle(AutomationElement el)
        {
            try { return new IntPtr(OnThread(() => el.Current.NativeWindowHandle, 3000)); } catch (Exception) { return IntPtr.Zero; }
        }

        static string NativeClick(AutomationElement el, bool dbl)
        {
            if (dbl) return null;
            // Check boxes / radio buttons keep their state inside the control: use the Toggle pattern.
            var ct = OnThread(() => el.Current.ControlType, 3000);
            IntPtr h = OwnHandle(el);
            // Check boxes / radio buttons keep their state inside the control: Toggle pattern (guarded).
            if (ct == ControlType.CheckBox || ct == ControlType.RadioButton) return null;
            if (h == IntPtr.Zero || h == target) return null;
            string cls = ClassOf(h);
            if (cls.StartsWith("WindowsForms10.BUTTON", StringComparison.OrdinalIgnoreCase))
            {
                // WinForms reflects BN_CLICKED back to the control: Click handlers and check boxes react.
                int idc = Native.GetDlgCtrlID(h);
                Native.PostMessage(Native.GetParent(h), WM_COMMAND, new IntPtr((BN_CLICKED << 16) | (idc & 0xFFFF)), h);
                return "clicked (control message)";
            }
            if (string.Equals(cls, "Button", StringComparison.OrdinalIgnoreCase))
            {
                Native.PostMessage(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return "clicked (BM_CLICK)";
            }
            return null;
        }

        static bool IsEditClass(string cls)
        {
            return cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0 && cls.IndexOf("COMBO", StringComparison.OrdinalIgnoreCase) < 0;
        }

        static IntPtr FocusOf(IntPtr top)
        {
            uint pid;
            uint thread = Native.GetWindowThreadProcessId(top, out pid);
            var gi = new Native.GUITHREADINFO();
            gi.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
            if (Native.GetGUIThreadInfo(thread, ref gi) && gi.hwndFocus != IntPtr.Zero) return gi.hwndFocus;
            return top;
        }

        static void PostChars(IntPtr h, string text)
        {
            foreach (char ch in text)
            {
                if (ch == '\n') { Native.PostMessage(h, WM_KEYDOWN, new IntPtr(0x0D), new IntPtr(0x001C0001)); Native.PostMessage(h, WM_CHAR, new IntPtr(0x0D), new IntPtr(0x001C0001)); Native.PostMessage(h, WM_KEYUP, new IntPtr(0x0D), new IntPtr(unchecked((int)0xC01C0001))); continue; }
                if (ch == '\r') continue;
                Native.PostMessage(h, WM_CHAR, new IntPtr(ch), new IntPtr(1));
            }
        }

        public static string Type(string id, IntPtr top, string text, bool clear)
        {
            return Guarded(() => TypeInner(id, top, text, clear));
        }

        static string TypeInner(string id, IntPtr top, string text, bool clear)
        {
            if (top == IntPtr.Zero) top = target;
            var el = ById(id);
            if (el != null)
            {
                IntPtr eh = OwnHandle(el);
                if (eh != IntPtr.Zero && eh != target && IsEditClass(ClassOf(eh)))
                {
                    // Classic edit / rich edit: set the text with messages (no focus change).
                    string t = text.Replace("\r\n", "\n").Replace("\n", "\r\n");
                    if (clear) Native.SendMessageText(eh, WM_SETTEXT, IntPtr.Zero, t);
                    else
                    {
                        Native.SendMessage(eh, EM_SETSEL, new IntPtr(-1), new IntPtr(-1)); // caret to the end
                        Native.SendMessageText(eh, EM_REPLACESEL, new IntPtr(1), t);
                    }
                    return "set text (control message)";
                }
                string set = OnThread(() =>
                {
                    object p;
                    if (text.IndexOf('\n') < 0 && el.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly)
                    {
                        var vp = (ValuePattern)p;
                        vp.SetValue(clear ? text : vp.Current.Value + text);
                        return "set value";
                    }
                    return null;
                }, 5000);
                if (set != null) return set;
                // A child window (classic edit/rich edit) of its own: type into it directly.
                IntPtr nh = OnThread(() => new IntPtr(el.Current.NativeWindowHandle), 3000);
                if (nh != IntPtr.Zero)
                {
                    if (clear) Native.SendMessage(nh, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
                    PostChars(nh, text);
                    return "posted characters to the field";
                }
                OnThread(() => { el.SetFocus(); return true; }, 3000); // may not move the user's focus: it is inside the target app
            }
            if (top == IntPtr.Zero || !Native.IsWindow(top)) throw new Exception("no target window");
            IntPtr fh = FocusOf(top);
            if (clear) Native.SendMessage(fh, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
            PostChars(fh, text);
            return "posted characters to the focused control";
        }

        public static string Key(IntPtr top, string keys, int repeat)
        {
            if (top == IntPtr.Zero) top = target;
            if (top == IntPtr.Zero || !Native.IsWindow(top)) throw new Exception("no target window");
            var parts = keys.ToLowerInvariant().Replace(" ", "").Split('+');
            IntPtr fh = FocusOf(top);
            if (parts.Length == 2 && parts[0] == "ctrl" && parts[1] == "a") { Native.SendMessage(fh, EM_SETSEL, IntPtr.Zero, new IntPtr(-1)); return "selected all text"; }
            if (parts.Length != 1) return Combo(top, fh, parts, keys);
            ushort vk = Input.ParseKey(parts[0]);
            uint scan = Native.MapVirtualKey(vk, 0);
            for (int i = 0; i < repeat; i++)
            {
                Native.PostMessage(fh, WM_KEYDOWN, new IntPtr(vk), new IntPtr((int)(1 | (scan << 16))));
                if (vk == 0x0D) Native.PostMessage(fh, WM_CHAR, new IntPtr(0x0D), new IntPtr((int)(1 | (scan << 16))));
                Native.PostMessage(fh, WM_KEYUP, new IntPtr(vk), new IntPtr(unchecked((int)(1 | (scan << 16) | 0xC0000000))));
            }
            return "posted key " + keys;
        }

        // ---------- key combinations (ctrl+s, ctrl+shift+n, alt+f4 ...) without the real keyboard ----------
        // 1) a classic menu item whose shortcut text matches ("저장(&S)\tCtrl+S") -> WM_COMMAND;
        // 2) a UI Automation element with that AcceleratorKey -> Invoke;
        // 3) the key messages themselves, with the modifier keys marked as down in the target
        //    thread's keyboard state (apps read it with GetKeyState), restored right after.
        const uint WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105, WM_CLOSE = 0x0010;

        static string NormCombo(string text)
        {
            var parts = new List<string>();
            foreach (var raw in text.ToLowerInvariant().Replace(" ", "").Split('+'))
            {
                string p = raw == "control" || raw == "컨트롤" ? "ctrl" : raw == "del" ? "delete" : raw == "esc" ? "escape" : raw;
                if (p.Length > 0) parts.Add(p);
            }
            var mods = new List<string>();
            foreach (var m in new[] { "ctrl", "alt", "shift" }) if (parts.Remove(m)) mods.Add(m);
            parts.Sort(StringComparer.Ordinal);
            mods.AddRange(parts);
            return string.Join("+", mods.ToArray());
        }

        static string MenuCommand(IntPtr top, string want)
        {
            IntPtr menu = Native.GetMenu(top);
            if (menu == IntPtr.Zero) return null;
            uint id = FindMenuItem(menu, want, 0);
            if (id == 0) return null;
            Native.PostMessage(top, WM_COMMAND, new IntPtr((int)id), IntPtr.Zero);
            return "menu command";
        }

        static uint FindMenuItem(IntPtr menu, string want, int depth)
        {
            int n = Native.GetMenuItemCount(menu);
            for (int i = 0; i < n && depth < 4; i++)
            {
                IntPtr sub = Native.GetSubMenu(menu, i);
                if (sub != IntPtr.Zero)
                {
                    uint found = FindMenuItem(sub, want, depth + 1);
                    if (found != 0) return found;
                    continue;
                }
                var sb = new StringBuilder(256);
                Native.GetMenuString(menu, (uint)i, sb, sb.Capacity, 0x0400); // MF_BYPOSITION
                string text = sb.ToString();
                int tab = text.IndexOf('\t');
                if (tab < 0 || NormCombo(text.Substring(tab + 1)) != want) continue;
                uint state = Native.GetMenuState(menu, (uint)i, 0x0400);
                if ((state & 0x0003) != 0) return 0; // grayed/disabled: the command is not available now
                return Native.GetMenuItemID(menu, i);
            }
            return 0;
        }

        static string AcceleratorInvoke(IntPtr top, string want)
        {
            return OnThread(() =>
            {
                var root = AutomationElement.FromHandle(top);
                var all = root.FindAll(TreeScope.Descendants, new NotCondition(new PropertyCondition(AutomationElement.AcceleratorKeyProperty, "")));
                foreach (AutomationElement e in all)
                {
                    string acc;
                    try { acc = e.Current.AcceleratorKey; } catch (Exception) { continue; }
                    if (string.IsNullOrEmpty(acc) || NormCombo(acc) != want) continue;
                    object p;
                    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked the element for the shortcut"; }
                }
                return null;
            }, 6000);
        }

        static string Combo(IntPtr top, IntPtr fh, string[] parts, string keys)
        {
            bool ctrl = false, alt = false, shift = false;
            var main = new List<string>();
            foreach (var p in parts)
            {
                if (p == "ctrl" || p == "control") ctrl = true;
                else if (p == "alt") alt = true;
                else if (p == "shift") shift = true;
                else if (p == "win" || p == "windows" || p == "lwin") throw new Exception("background mode can't use the Windows key (" + keys + "): it acts on the user's desktop");
                else if (p.Length > 0) main.Add(p);
            }
            if (main.Count != 1) throw new Exception("key combination needs exactly one main key: " + keys);
            if (alt && !ctrl && !shift && main[0] == "f4") { Native.PostMessage(top, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return "closed the window (WM_CLOSE)"; }
            if (alt && !ctrl && main[0] == "tab") throw new Exception("background mode can't switch windows with alt+tab: use focus_window N");
            string want = NormCombo(keys);
            string r = MenuCommand(top, want);
            if (r != null) return r + " (" + keys + ")";
            try { r = AcceleratorInvoke(top, want); } catch (Exception) { r = null; }
            if (r != null) return r + " (" + keys + ")";
            return PostCombo(top, fh, ctrl, alt, shift, Input.ParseKey(main[0])) + " (" + keys + ")";
        }

        static string PostCombo(IntPtr top, IntPtr fh, bool ctrl, bool alt, bool shift, ushort vk)
        {
            uint pid;
            uint thread = Native.GetWindowThreadProcessId(top, out pid);
            uint me = Native.GetCurrentThreadId();
            bool attached = thread != me && Native.AttachThreadInput(me, thread, true);
            var saved = new byte[256];
            Native.GetKeyboardState(saved);
            try
            {
                var state = (byte[])saved.Clone();
                if (ctrl) { state[0x11] = 0x80; state[0xA2] = 0x80; }
                if (alt) { state[0x12] = 0x80; state[0xA4] = 0x80; }
                if (shift) { state[0x10] = 0x80; state[0xA0] = 0x80; }
                Native.SetKeyboardState(state);
                uint down = alt && !ctrl ? WM_SYSKEYDOWN : WM_KEYDOWN, up = alt && !ctrl ? WM_SYSKEYUP : WM_KEYUP;
                uint ctx = alt ? 0x20000000u : 0u; // "context code": alt is down
                var mods = new List<ushort>();
                if (ctrl) mods.Add(0x11);
                if (alt) mods.Add(0x12);
                if (shift) mods.Add(0x10);
                foreach (var m in mods) Native.PostMessage(fh, down, new IntPtr(m), new IntPtr((int)(1 | (Native.MapVirtualKey(m, 0) << 16) | ctx)));
                uint scan = Native.MapVirtualKey(vk, 0);
                Native.PostMessage(fh, down, new IntPtr(vk), new IntPtr((int)(1 | (scan << 16) | ctx)));
                // The app reads the keyboard state when it handles the message: keep it until then.
                Native.SendMessageTimeout(fh, 0, IntPtr.Zero, IntPtr.Zero, 0x0002, 1500, IntPtr.Zero); // WM_NULL, SMTO_ABORTIFHUNG
                Thread.Sleep(150);
                Native.PostMessage(fh, up, new IntPtr(vk), new IntPtr(unchecked((int)(1 | (scan << 16) | ctx | 0xC0000000))));
                for (int i = mods.Count - 1; i >= 0; i--) Native.PostMessage(fh, up, new IntPtr(mods[i]), new IntPtr(unchecked((int)(1 | (Native.MapVirtualKey(mods[i], 0) << 16) | 0xC0000000))));
                Thread.Sleep(80);
            }
            finally
            {
                Native.SetKeyboardState(saved);
                if (attached) Native.AttachThreadInput(me, thread, false);
            }
            return "posted key combination; some apps (new WinUI apps such as Windows 11 Notepad) ignore it: check the screen, and use the menu/button by id if nothing changed";
        }

        // ---------- drag (window messages; a slider by element id moves through RangeValue) ----------
        // Screen positions can be negative (a monitor left of the main one): "no position" is NoPos.
        public const int NoPos = int.MinValue;

        public static string Drag(string id, int x1, int y1, int x2, int y2)
        {
            if (target == IntPtr.Zero || !Native.IsWindow(target)) throw new Exception("no target window: observe it first");
            var el = ById(id);
            if (el != null)
            {
                string moved = OnThread(() =>
                {
                    object p;
                    if (!el.TryGetCurrentPattern(RangeValuePattern.Pattern, out p)) return null;
                    var rv = (RangeValuePattern)p;
                    var r = el.Current.BoundingRectangle;
                    bool vertical = r.Height > r.Width;
                    double f = vertical ? (r.Bottom - y2) / Math.Max(1, r.Height) : (x2 - r.Left) / Math.Max(1, r.Width);
                    f = Math.Max(0, Math.Min(1, f));
                    rv.SetValue(rv.Current.Minimum + f * (rv.Current.Maximum - rv.Current.Minimum));
                    return "set the slider value";
                }, 5000);
                if (moved != null) return moved;
                if (x1 == NoPos)
                {
                    var r = OnThread(() => el.Current.BoundingRectangle, 3000);
                    x1 = (int)(r.X + r.Width / 2);
                    y1 = (int)(r.Y + r.Height / 2);
                }
            }
            if (x1 == NoPos || y1 == NoPos || x2 == NoPos || y2 == NoPos) throw new Exception("drag needs from and to positions");
            Native.POINT c;
            IntPtr h = ChildAt(target, x1, y1, out c);
            IntPtr mk = new IntPtr(0x0001); // MK_LBUTTON
            Native.PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(c.X, c.Y));
            Native.PostMessage(h, WM_LBUTTONDOWN, mk, MakeLParam(c.X, c.Y));
            const int steps = 12;
            for (int i = 1; i <= steps; i++)
            {
                Thread.Sleep(15);
                var pt = new Native.POINT { X = x1 + (x2 - x1) * i / steps, Y = y1 + (y2 - y1) * i / steps };
                Native.ScreenToClient(h, ref pt); // the window that got the button keeps the mouse (as with capture)
                Native.PostMessage(h, WM_MOUSEMOVE, mk, MakeLParam(pt.X, pt.Y));
            }
            var end = new Native.POINT { X = x2, Y = y2 };
            Native.ScreenToClient(h, ref end);
            Thread.Sleep(30);
            Native.PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, MakeLParam(end.X, end.Y));
            return "posted drag messages";
        }

        public static string Scroll(string id, int x, int y, int amount, bool horizontal)
        {
            var el = ById(id);
            if (el == null && target != IntPtr.Zero && x == NoPos)
            {
                // No target given: the first scrollable element of the window.
                lock (Live) foreach (var e in Live) { object sp; try { if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out sp)) { el = e; break; } } catch (Exception) { } }
            }
            if (el != null)
            {
                string done = OnThread(() =>
                {
                    for (var cur = el; cur != null; cur = TreeWalker.ControlViewWalker.GetParent(cur))
                    {
                        object p;
                        if (!cur.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) continue;
                        var sp = (ScrollPattern)p;
                        var amt = amount < 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
                        for (int i = 0; i < Math.Min(30, Math.Abs(amount)); i++)
                        {
                            if (horizontal) { if (sp.Current.HorizontallyScrollable) sp.ScrollHorizontal(amt); }
                            else if (sp.Current.VerticallyScrollable) sp.ScrollVertical(amt);
                        }
                        return "scrolled";
                    }
                    return null;
                }, 5000);
                if (done != null) return done;
                var r = OnThread(() => el.Current.BoundingRectangle, 3000);
                x = (int)(r.X + r.Width / 2);
                y = (int)(r.Y + r.Height / 2);
            }
            if (x == NoPos || y == NoPos || target == IntPtr.Zero) throw new Exception("nothing to scroll");
            Native.POINT c;
            IntPtr h = ChildAt(target, x, y, out c);
            Native.PostMessage(h, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, new IntPtr((amount * 120) << 16), MakeLParam(x, y));
            return "posted wheel message";
        }

        // A window the agent opened: put it behind the user's windows without activating it,
        // and give the focus back to the user's window if the new app grabbed it.
        public static bool Place(IntPtr h, IntPtr restore)
        {
            if (!Native.IsWindow(h)) return false;
            if (Native.IsIconic(h)) Native.ShowWindow(h, 4); // SW_SHOWNOACTIVATE
            Native.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_BOTTOM, NOSIZE|NOMOVE|NOACTIVATE
            if (restore != IntPtr.Zero && Native.IsWindow(restore) && Native.GetForegroundWindow() == h) Windows.Focus(restore);
            target = h;
            return true;
        }
    }

    // UI Automation: the desktop equivalent of the browser's accessibility snapshot.
    static class UiTree
    {
        static readonly ControlType[] Interactive = {
            ControlType.Button, ControlType.Edit, ControlType.Hyperlink, ControlType.MenuItem, ControlType.ListItem,
            ControlType.TabItem, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.TreeItem,
            ControlType.SplitButton, ControlType.DataItem, ControlType.Document, ControlType.Slider, ControlType.Spinner,
            ControlType.MenuBar,
        };

        public static List<Dictionary<string, object>> Collect(IntPtr fg, Rectangle bounds, int max, int timeoutMs)
        {
            var found = new List<Dictionary<string, object>>();
            var roots = new List<IntPtr>();
            if (fg != IntPtr.Zero) roots.Add(fg);
            IntPtr tray = Native.FindWindow("Shell_TrayWnd", null);
            if (tray != IntPtr.Zero && tray != fg) roots.Add(tray);

            // The taskbar gets its own share so a busy window can't crowd out app switching.
            int taskbarShare = Math.Min(40, max / 3);
            var worker = new Thread(() =>
            {
                foreach (var hwnd in roots)
                {
                    bool isTray = hwnd == tray;
                    int limit;
                    lock (found) limit = isTray ? Math.Min(max, found.Count + taskbarShare) : max - (roots.Contains(tray) ? taskbarShare : 0);
                    try { CollectFrom(hwnd, bounds, found, limit, isTray ? "taskbar" : "window"); }
                    catch (Exception) { }
                }
            });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(timeoutMs); // UIA can hang on unresponsive apps; return what we have
            lock (found)
            {
                var copy = new List<Dictionary<string, object>>(found);
                for (int i = 0; i < copy.Count; i++) copy[i]["id"] = "d" + (i + 1);
                return copy;
            }
        }

        // Element under a screen point (used to name the target of coordinate clicks).
        public static Dictionary<string, object> At(int x, int y, int timeoutMs)
        {
            Dictionary<string, object> result = null;
            var worker = new Thread(() =>
            {
                try
                {
                    var el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                    if (el == null) return;
                    var d = new Dictionary<string, object>();
                    d["role"] = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
                    d["name"] = Clean(el.Current.Name);
                    result = d;
                }
                catch (Exception) { }
            });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(timeoutMs);
            return result;
        }

        // Sets an edit field's text through UIA ValuePattern (no keyboard: immune to IME and
        // autocomplete). Returns the field's value afterwards; throws if the point has no editable field.
        public static string SetValueAt(int x, int y, string text, int timeoutMs)
        {
            string result = null;
            string error = "no editable field at that point";
            var worker = new Thread(() =>
            {
                try
                {
                    var el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                    // A combo box's text lives in its child edit.
                    for (int i = 0; el != null && i < 3; i++)
                    {
                        object vp;
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp) && !((ValuePattern)vp).Current.IsReadOnly)
                        {
                            try { el.SetFocus(); } catch (Exception) { }
                            ((ValuePattern)vp).SetValue(text);
                            result = ((ValuePattern)vp).Current.Value;
                            return;
                        }
                        var child = TreeWalker.ControlViewWalker.GetFirstChild(el);
                        el = child;
                    }
                }
                catch (Exception e) { error = e.Message; }
            });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(timeoutMs);
            if (result == null) throw new Exception(error);
            return result;
        }

        // Readable text of a window or element. Documents/edits/browsers: the TextPattern (whole text,
        // not only what is visible). Everything else: names/values of text-bearing elements, laid out
        // in rows by screen position ("a | b | c") so lists and grids read like tables.
        public static string ReadText(IntPtr hwnd, int x, int y, int max, int timeoutMs)
        {
            var sb = new StringBuilder();
            var worker = new Thread(() =>
            {
                try
                {
                    AutomationElement root = x >= 0 && y >= 0 ? AutomationElement.FromPoint(new System.Windows.Point(x, y)) : AutomationElement.FromHandle(hwnd);
                    if (root == null) return;
                    string t = DocText(root, max);
                    if (t != null)
                    {
                        lock (sb) sb.Append(t);
                        return;
                    }
                    WalkText(root, sb, max);
                }
                catch (Exception) { }
            });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(timeoutMs);
            lock (sb) return sb.ToString();
        }

        // Whole text of a document-like element (Word page, browser page, rich edit), else null.
        static string DocText(AutomationElement el, int max)
        {
            object tp;
            var ct = el.Current.ControlType;
            if ((ct != ControlType.Document && ct != ControlType.Edit) || !el.TryGetCurrentPattern(TextPattern.Pattern, out tp)) return null;
            string t = ((TextPattern)tp).DocumentRange.GetText(max);
            return string.IsNullOrEmpty(t) || t.Trim().Length == 0 ? null : t;
        }

        static readonly ControlType[] TextTypes = new ControlType[] {
            ControlType.Text, ControlType.Edit, ControlType.Document, ControlType.DataItem, ControlType.ListItem,
            ControlType.TreeItem, ControlType.Hyperlink, ControlType.HeaderItem, ControlType.Header, ControlType.Custom, ControlType.TabItem,
        };

        class Piece { public double X, Y, H; public string Text; }

        static void WalkText(AutomationElement root, StringBuilder sb, int max)
        {
            var pieces = new List<Piece>();
            var walker = TreeWalker.ControlViewWalker;
            var stack = new Stack<AutomationElement>();
            stack.Push(root);
            int seen = 0, chars = 0;
            while (stack.Count > 0 && seen < 5000 && chars < max)
            {
                var el = stack.Pop();
                seen++;
                try
                {
                    var ct = el.Current.ControlType;
                    if (ct == ControlType.Document)
                    {
                        // Documents carry huge trees; their TextPattern has the full text in order.
                        string doc = DocText(el, max - chars);
                        if (doc != null)
                        {
                            var dr = el.Current.BoundingRectangle;
                            pieces.Add(new Piece { X = dr.IsEmpty ? 0 : dr.X, Y = dr.IsEmpty ? double.MaxValue : dr.Y, H = 1e9, Text = doc.Trim() });
                            chars += doc.Length;
                            continue;
                        }
                    }
                    // A grid row's own value repeats its cells ("a;b;c"): read the cells instead.
                    bool rowWithCells = (ct == ControlType.DataItem || ct == ControlType.Custom || ct == ControlType.ListItem || ct == ControlType.Header)
                        && walker.GetFirstChild(el) != null;
                    if (Array.IndexOf(TextTypes, ct) >= 0 && !rowWithCells)
                    {
                        string name = Clean(el.Current.Name);
                        string value = "";
                        object vp;
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) value = Clean(((ValuePattern)vp).Current.Value);
                        string text = value.Length > 0 && value != name ? (name.Length > 0 && ct != ControlType.Edit && ct != ControlType.Custom && ct != ControlType.DataItem ? name + ": " + value : value) : name;
                        if (text == "(null)") text = "";
                        if (text.Length > 0)
                        {
                            var r = el.Current.BoundingRectangle;
                            pieces.Add(new Piece { X = r.IsEmpty ? 0 : r.X, Y = r.IsEmpty ? double.MaxValue : r.Y, H = r.IsEmpty ? 0 : r.Height, Text = text });
                            chars += text.Length + 3;
                        }
                    }
                    // Children in reverse so the stack pops them in document order.
                    var kids = new List<AutomationElement>();
                    for (var c = walker.GetFirstChild(el); c != null && kids.Count < 500; c = walker.GetNextSibling(c)) kids.Add(c);
                    for (int i = kids.Count - 1; i >= 0; i--) stack.Push(kids[i]);
                }
                catch (Exception) { }
            }
            // Group into rows: pieces whose tops are within half a line height share a row.
            pieces.Sort((a, b) => a.Y != b.Y ? a.Y.CompareTo(b.Y) : a.X.CompareTo(b.X));
            var rows = new List<List<Piece>>();
            foreach (var p in pieces)
            {
                var last = rows.Count > 0 ? rows[rows.Count - 1] : null;
                // Only single-line pieces share rows; a tall text box or document is a block of its own.
                bool small = p.H > 0 && p.H < 60 && last != null && last[0].H > 0 && last[0].H < 60;
                if (small && p.Y != double.MaxValue && Math.Abs(p.Y - last[0].Y) <= Math.Max(4, Math.Min(p.H, last[0].H) / 2)) last.Add(p);
                else rows.Add(new List<Piece> { p });
            }
            string prev = null;
            foreach (var row in rows)
            {
                row.Sort((a, b) => a.X.CompareTo(b.X));
                var cells = new List<string>();
                foreach (var p in row) if (cells.Count == 0 || cells[cells.Count - 1] != p.Text) cells.Add(p.Text);
                string line = string.Join(" | ", cells.ToArray());
                if (line == prev) continue; // parent and child often carry the same name
                prev = line;
                lock (sb)
                {
                    if (sb.Length + line.Length > max) return;
                    sb.Append(line).Append('\n');
                }
            }
        }

        // Standard Windows Open/Save dialog: put the path into the file-name box (AutomationId 1148)
        // with ValuePattern (no keyboard) and invoke the OK/열기 button (AutomationId 1).
        public static Dictionary<string, object> FillFileDialog(IntPtr hwnd, string path, int timeoutMs)
        {
            var result = new Dictionary<string, object>();
            string error = "timed out";
            var worker = new Thread(() =>
            {
                try
                {
                    var root = AutomationElement.FromHandle(hwnd);
                    if (root.Current.ClassName != "#32770") { error = "the window in front is not a file dialog"; return; }
                    var box = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "1148"));
                    if (box == null) { error = "no file-name box in this dialog"; return; }
                    object vp;
                    if (!box.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                    {
                        var edit = box.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                        if (edit == null || !edit.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { error = "file-name box is not editable"; return; }
                    }
                    ((ValuePattern)vp).SetValue(path);
                    result["value"] = ((ValuePattern)vp).Current.Value;
                    var ok = root.FindFirst(TreeScope.Descendants, new AndCondition(
                        new PropertyCondition(AutomationElement.AutomationIdProperty, "1"),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
                    object ip;
                    if (ok == null || !ok.TryGetCurrentPattern(InvokePattern.Pattern, out ip)) { error = "no OK/열기 button"; return; }
                    result["button"] = Clean(ok.Current.Name);
                    ((InvokePattern)ip).Invoke();
                    error = null;
                }
                catch (Exception e) { error = e.Message; }
            });
            worker.IsBackground = true;
            worker.Start();
            worker.Join(timeoutMs);
            if (error != null) throw new Exception(error);
            Thread.Sleep(600);
            result["closed"] = !Native.IsWindow(hwnd) || !Native.IsWindowVisible(hwnd);
            return result;
        }

        internal static void CollectFrom(IntPtr hwnd, Rectangle bounds, List<Dictionary<string, object>> found, int max, string area, List<AutomationElement> live = null)
        {
            var root = AutomationElement.FromHandle(hwnd);
            var types = new List<Condition>();
            foreach (var t in Interactive) types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, t));
            var cond = new AndCondition(
                new OrCondition(types.ToArray()),
                new PropertyCondition(AutomationElement.IsOffscreenProperty, false));

            var cache = new CacheRequest();
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsEnabledProperty);
            cache.Add(AutomationElement.AutomationIdProperty);
            cache.Add(AutomationElement.HelpTextProperty);
            cache.Add(ValuePattern.ValueProperty);
            cache.Add(TogglePattern.ToggleStateProperty);
            // Background mode keeps live elements so actions can use their patterns later.
            cache.AutomationElementMode = live != null ? AutomationElementMode.Full : AutomationElementMode.None;

            AutomationElementCollection all;
            using (cache.Activate()) all = root.FindAll(TreeScope.Descendants, cond);

            foreach (AutomationElement el in all)
            {
                lock (found) if (found.Count >= max) return;
                System.Windows.Rect r = (System.Windows.Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
                if (r.IsEmpty || r.Width < 4 || r.Height < 4) continue;
                var rect = new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
                rect.Intersect(bounds);
                if (rect.Width < 4 || rect.Height < 4) continue;

                var ct = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
                string name = Clean(el.GetCachedPropertyValue(AutomationElement.NameProperty) as string);
                if (name.Length == 0) name = Clean(el.GetCachedPropertyValue(AutomationElement.HelpTextProperty) as string);
                if (name.Length == 0) name = Clean(el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty) as string);

                var item = new Dictionary<string, object>();
                item["role"] = ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
                item["name"] = name.Length > 80 ? name.Substring(0, 80) : name;
                item["x"] = rect.X;
                item["y"] = rect.Y;
                item["w"] = rect.Width;
                item["h"] = rect.Height;
                item["area"] = area;
                if (!(bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty)) item["disabled"] = true;
                object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
                if (v is string && ((string)v).Length > 0) item["value"] = Clean(((string)v).Length > 80 ? ((string)v).Substring(0, 80) : (string)v);
                object ts = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
                if (ts is ToggleState) item["checked"] = (ToggleState)ts == ToggleState.On;
                lock (found)
                {
                    found.Add(item);
                    if (live != null) live.Add(el);
                }
            }
        }

        static string Clean(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace('\r', ' ').Replace('\n', ' ').Trim();
        }
    }

    static class Windows
    {
        public static List<Dictionary<string, object>> List()
        {
            var list = new List<Dictionary<string, object>>();
            IntPtr shell = Native.GetShellWindow();
            Native.EnumWindows((h, l) =>
            {
                if (h == shell || !Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return true;
                long ex = Native.GetWindowLongPtr(h, -20).ToInt64();
                if ((ex & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
                int cloaked;
                if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                list.Add(Describe(h));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static Dictionary<string, object> Describe(IntPtr h)
        {
            var d = new Dictionary<string, object>();
            d["hwnd"] = h.ToInt64();
            if (h == IntPtr.Zero) return d;
            var sb = new StringBuilder(512);
            Native.GetWindowText(h, sb, sb.Capacity);
            d["title"] = sb.ToString();
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            try { d["process"] = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { d["process"] = ""; }
            d["minimized"] = Native.IsIconic(h);
            var cls = new StringBuilder(256);
            Native.GetClassName(h, cls, cls.Capacity);
            d["class"] = cls.ToString();
            Native.RECT r;
            if (Native.GetWindowRect(h, out r)) d["rect"] = new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
            return d;
        }

        public static bool Focus(IntPtr h)
        {
            if (!Native.IsWindow(h)) throw new Exception("window not found");
            if (Native.IsIconic(h)) Native.ShowWindow(h, 9); // SW_RESTORE
            // Windows only lets the foreground process change focus; a synthetic Alt press unlocks it.
            Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
            Native.keybd_event(0x12, 0, 2, UIntPtr.Zero);
            Native.BringWindowToTop(h);
            bool ok = Native.SetForegroundWindow(h);
            Thread.Sleep(150);
            return ok && Native.GetForegroundWindow() == h;
        }
    }

    static class Input
    {
        const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x01000;
        const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

        public static void Mouse(string action, int x, int y, string button)
        {
            MoveTo(x, y);
            if (action == "move") return;
            uint down = LDOWN, up = LUP;
            if (button == "right" || action == "right_click") { down = RDOWN; up = RUP; }
            else if (button == "middle") { down = MDOWN; up = MUP; }
            int clicks = action == "double_click" ? 2 : action == "triple_click" ? 3 : 1;
            if (action == "down") { SendMouse(down, 0); return; }
            if (action == "up") { SendMouse(up, 0); return; }
            for (int i = 0; i < clicks; i++)
            {
                SendMouse(down, 0);
                SendMouse(up, 0);
                if (i < clicks - 1) Thread.Sleep(40);
            }
        }

        public static void Drag(int x1, int y1, int x2, int y2)
        {
            MoveTo(x1, y1);
            SendMouse(LDOWN, 0);
            Thread.Sleep(80);
            const int steps = 15;
            for (int i = 1; i <= steps; i++)
            {
                Native.SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
                SendMouse(MOVE, 0, 0, 0);
                Thread.Sleep(15);
            }
            Thread.Sleep(80);
            SendMouse(LUP, 0);
        }

        public static void Scroll(int x, int y, int amount, bool horizontal)
        {
            MoveTo(x, y);
            // amount: notches, negative = down (vertical) / left (horizontal)
            int sign = Math.Sign(amount);
            for (int i = 0; i < Math.Min(30, Math.Abs(amount)); i++)
            {
                SendMouse(horizontal ? HWHEEL : WHEEL, sign * 120);
                Thread.Sleep(20);
            }
        }

        static void MoveTo(int x, int y)
        {
            Native.SetCursorPos(x, y);
            Thread.Sleep(30);
        }

        static void SendMouse(uint flags, int data) { SendMouse(flags, data, 0, 0); }

        static void SendMouse(uint flags, int data, int dx, int dy)
        {
            var inp = new Native.INPUT { type = 0 };
            inp.U.mi = new Native.MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
            Native.SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(Native.INPUT)));
        }

        static Native.INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var inp = new Native.INPUT { type = 1 };
            inp.U.ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
            return inp;
        }

        public static void EnsureForeground(IntPtr guard)
        {
            if (guard == IntPtr.Zero) return;
            IntPtr fg = Native.GetForegroundWindow();
            if (fg != guard) throw new Exception("focus changed to another window (" + Windows.Describe(fg)["title"] + "); stopped typing");
        }

        // Unicode injection: bypasses the keyboard layout / IME, so Korean text types correctly.
        // With a guard window, stops as soon as another window takes focus. Returns chars typed.
        public static int TypeText(string text, IntPtr guard)
        {
            int typed = 0;
            var batch = new List<Native.INPUT>();
            Action flush = () =>
            {
                if (batch.Count == 0) return;
                EnsureForeground(guard);
                Native.SendInput((uint)batch.Count, batch.ToArray(), Marshal.SizeOf(typeof(Native.INPUT)));
                batch.Clear();
                Thread.Sleep(10);
            };
            foreach (char c in text.Replace("\r\n", "\n"))
            {
                if (c == '\n' || c == '\t')
                {
                    ushort vk = (ushort)(c == '\n' ? 0x0D : 0x09);
                    batch.Add(Key(vk, 0, 0));
                    batch.Add(Key(vk, 0, KEYUP));
                }
                else
                {
                    batch.Add(Key(0, c, UNICODE));
                    batch.Add(Key(0, c, UNICODE | KEYUP));
                }
                typed++;
                if (batch.Count >= 16) flush();
            }
            flush();
            return typed;
        }

        static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B }, { "meta", 0x5B }, { "super", 0x5B }, { "cmd", 0x5B },
            { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B }, { "tab", 0x09 }, { "space", 0x20 },
            { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
            { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
            { "arrowup", 0x26 }, { "arrowdown", 0x28 }, { "arrowleft", 0x25 }, { "arrowright", 0x27 },
            { "printscreen", 0x2C }, { "capslock", 0x14 }, { "apps", 0x5D }, { "menu", 0x5D },
            { "hangul", 0x15 }, { "hanja", 0x19 }, { "volumeup", 0xAF }, { "volumedown", 0xAE }, { "volumemute", 0xAD },
            { "-", 0xBD }, { "=", 0xBB }, { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF }, { ";", 0xBA }, { "'", 0xDE },
            { "[", 0xDB }, { "]", 0xDD }, { "\\", 0xDC }, { "`", 0xC0 },
        };
        static readonly HashSet<ushort> ExtendedKeys = new HashSet<ushort> { 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B, 0x5D, 0x2C };

        internal static ushort ParseKey(string name)
        {
            ushort vk;
            if (Vk.TryGetValue(name, out vk)) return vk;
            if (name.Length == 1)
            {
                char c = char.ToUpperInvariant(name[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
            }
            if (name.Length >= 2 && (name[0] == 'f' || name[0] == 'F'))
            {
                int n;
                if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
            }
            throw new Exception("unknown key '" + name + "'");
        }

        // "ctrl+shift+s", "alt+f4", "win+r", "enter"
        public static void KeyCombo(string combo, int repeat)
        {
            var parts = combo.Replace(" ", "").Split('+');
            var vks = new List<ushort>();
            foreach (var p in parts) if (p.Length > 0) vks.Add(ParseKey(p));
            if (combo.EndsWith("++")) vks.Add(0xBB); // "ctrl++"
            if (vks.Count == 0) throw new Exception("empty key combo");
            for (int r = 0; r < repeat; r++)
            {
                var seq = new List<Native.INPUT>();
                foreach (var vk in vks) seq.Add(Key(vk, (ushort)Native.MapVirtualKey(vk, 0), ExtendedKeys.Contains(vk) ? EXTENDED : 0));
                for (int i = vks.Count - 1; i >= 0; i--) seq.Add(Key(vks[i], (ushort)Native.MapVirtualKey(vks[i], 0), KEYUP | (ExtendedKeys.Contains(vks[i]) ? EXTENDED : 0)));
                Native.SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(Native.INPUT)));
                Thread.Sleep(40);
            }
        }
    }

    static class Native
    {
        public static void EnableDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
            try { SetProcessDPIAware(); } catch (Exception) { }
        }

        // Real paths of known folders (Desktop is often redirected to OneDrive).
        public static string KnownFolder(Guid id)
        {
            IntPtr p;
            if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out p) != 0) return "";
            try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
        }
        [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion U; }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l); // Unicode: WM_CHAR carries UTF-16
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, IntPtr result);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageText(IntPtr h, uint msg, IntPtr w, string l);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
        [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
        [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] state);
        [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte[] state);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
        [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
        [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int pos);
        [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int pos);
        [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetMenuStringW", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint item, StringBuilder sb, int max, uint flags);
        [StructLayout(LayoutKind.Sequential)]
        public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
    }
}
