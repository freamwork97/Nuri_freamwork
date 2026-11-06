// Nuri — macOS desktop helper (the Mac counterpart of DesktopHelper.cs).
//
// Same protocol as anb-desktop.exe: one JSON request per stdin line, one JSON reply per stdout
// line ({"id":..,"ok":true,...} or {"ok":false,"error":".."}); the first line is {"ready":true}.
// Only the BACKGROUND commands exist here (the app always uses background mode on a Mac): the
// user's mouse, keyboard and frontmost app are never touched.
//   windows, foreground, folders, cursor, ping
//   wobserve  - screenshot of ONE window (ScreenCaptureKit) + its Accessibility elements (ids d1..)
//   bgclick   - AXPress on the element (by id, or the element at x,y), else a mouse event to the app's pid
//   bgtype    - set AXValue of the field, else unicode key events to the app's pid
//   bgkey     - key / combination (cmd+s ...) as key events to the app's pid
//   bgscroll  - scroll wheel event to the app's pid
//   bgdrag    - a slider (by id) gets its value set; other drags are not supported
//   bgplace   - make a window the target (apps opened by launch stay in the background)
//   launch    - open -g (app name, URL or file) without activating it
//   readtext  - text of a window's Accessibility tree
//   close     - AXPress the window's close button
//   filedialog- choose a file in the target window's Open sheet (cmd+shift+g, path, return)
//
// Coordinates are global screen points (top-left origin), like AX positions and CGWindow bounds.
// Needs macOS 14+, and the Accessibility + Screen Recording permissions (System Settings > Privacy
// & Security); "ready" reports whether they are granted.
// Build: native/mac/build-mac.sh (swiftc). NOT yet built or run on a Mac — see build-mac.sh.

import AppKit
import ApplicationServices
import Foundation
@preconcurrency import ScreenCaptureKit

// MARK: - JSON helpers

typealias Json = [String: Any]

func str(_ req: Json, _ key: String, _ def: String = "") -> String {
    if let s = req[key] as? String { return s }
    if let n = req[key] as? NSNumber { return n.stringValue }
    return def
}

func int(_ req: Json, _ key: String) -> Int? {
    if let n = req[key] as? NSNumber { return n.intValue }
    if let s = req[key] as? String { return Int(s) }
    return nil
}

func bool(_ req: Json, _ key: String, _ def: Bool = false) -> Bool {
    (req[key] as? NSNumber)?.boolValue ?? def
}

struct HelperError: Error, CustomStringConvertible, Sendable {
    let description: String
    init(_ d: String) { description = d }
}

// MARK: - Windows (CGWindowList)

struct WindowInfo {
    let id: Int
    let pid: pid_t
    let title: String
    let process: String
    let bounds: CGRect

    var json: Json {
        ["hwnd": id, "title": title, "process": process, "minimized": false, "class": "",
         "rect": [Int(bounds.minX), Int(bounds.minY), Int(bounds.width), Int(bounds.height)]]
    }
}

enum Windows {
    /// Normal app windows on screen, front to back.
    static func list() -> [WindowInfo] {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [Json] else { return [] }
        let me = ProcessInfo.processInfo.processIdentifier
        return raw.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let id = w[kCGWindowNumber as String] as? Int,
                  let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            let rect = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if rect.width < 40 || rect.height < 40 { return nil }
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            let title = (w[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? owner
            return WindowInfo(id: id, pid: pid, title: title, process: owner, bounds: rect)
        }
    }

    static func find(_ id: Int) throws -> WindowInfo {
        guard let w = list().first(where: { $0.id == id }) else { throw HelperError("window not found (it was closed or minimized)") }
        return w
    }

    /// The user's frontmost window.
    static func foreground() -> WindowInfo? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        return list().first(where: { $0.pid == pid })
    }

    /// The Accessibility element of a CGWindow: the app's AXWindow with the same frame.
    static func axWindow(_ w: WindowInfo) -> AXUIElement? {
        let app = AXUIElementCreateApplication(w.pid)
        guard let wins = Ax.attr(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
        var best: AXUIElement?
        var bestDist = CGFloat.greatestFiniteMagnitude
        for win in wins {
            guard let f = Ax.frame(win) else { continue }
            let d = abs(f.minX - w.bounds.minX) + abs(f.minY - w.bounds.minY) + abs(f.width - w.bounds.width) + abs(f.height - w.bounds.height)
            if d < bestDist { bestDist = d; best = win }
        }
        return bestDist < 40 ? best : wins.first
    }
}

// MARK: - Accessibility

enum Ax {
    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ name: String) -> String {
        if let s = attr(el, name) as? String { return s }
        if let n = attr(el, name) as? NSNumber { return n.stringValue }
        return ""
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero
        var sz = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &pt)
        AXValueGetValue(s as! AXValue, .cgSize, &sz)
        return CGRect(origin: pt, size: sz)
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(el, &names) == .success ? (names as? [String] ?? []) : []
    }

    static func settable(_ el: AXUIElement, _ name: String) -> Bool {
        var ok = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(el, name as CFString, &ok) == .success && ok.boolValue
    }

    static let interactive: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox",
        "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink", "AXTab", "AXSlider", "AXIncrementor",
        "AXDisclosureTriangle", "AXRow", "AXCell", "AXSearchField", "AXSecureTextField", "AXWebArea", "AXStaticText",
    ]

    /// Visible interactive elements inside `bounds`, depth-first, at most `max`.
    static func collect(_ root: AXUIElement, bounds: CGRect, max: Int) -> [(AXUIElement, Json)] {
        var out: [(AXUIElement, Json)] = []
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        let deadline = Date().addingTimeInterval(3)
        while let item = stack.popLast(), out.count < max, visited < 4000, Date() < deadline {
            let (el, depth) = item
            visited += 1
            let role = string(el, kAXRoleAttribute)
            if interactive.contains(role), let f = frame(el), f.width >= 2, f.height >= 2, bounds.intersects(f) {
                var name = string(el, kAXTitleAttribute)
                if name.isEmpty { name = string(el, kAXDescriptionAttribute) }
                if name.isEmpty, role != "AXSecureTextField" { name = string(el, kAXValueAttribute) }
                if name.isEmpty { name = string(el, kAXHelpAttribute) }
                if !(role == "AXStaticText" && name.isEmpty) {
                    out.append((el, ["role": role.replacingOccurrences(of: "AX", with: "").lowercased(),
                                     "name": String(name.prefix(80)), "x": Int(f.minX), "y": Int(f.minY),
                                     "w": Int(f.width), "h": Int(f.height), "area": "window"]))
                }
            }
            if depth < 40, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
                for k in kids.reversed() { stack.append((k, depth + 1)) }
            }
        }
        return out
    }

    /// All text of a subtree (values, titles, static texts), one line per element.
    static func text(_ root: AXUIElement, max: Int) -> String {
        var lines: [String] = []
        var total = 0
        var stack: [AXUIElement] = [root]
        var visited = 0
        while let el = stack.popLast(), total < max, visited < 8000 {
            visited += 1
            let role = string(el, kAXRoleAttribute)
            if role != "AXSecureTextField" {
                for key in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                    let s = string(el, key).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !s.isEmpty, lines.last != s { lines.append(s); total += s.count; break }
                }
            }
            if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: kids.reversed()) }
        }
        return String(lines.joined(separator: "\n").prefix(max))
    }
}

// MARK: - Screenshot (ScreenCaptureKit) with element marks

enum Capture {
    /// Filled by the capture task; read after the semaphore.
    final class Box: @unchecked Sendable {
        var result: Result<CGImage, Error> = .failure(HelperError("capture timed out"))
    }

    static func window(_ w: WindowInfo, width: Int, height: Int) throws -> CGImage {
        let sem = DispatchSemaphore(value: 0)
        let box = Box()
        let windowID = w.id
        Task.detached {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let scw = content.windows.first(where: { Int($0.windowID) == windowID }) else { throw HelperError("window not capturable") }
                let filter = SCContentFilter(desktopIndependentWindow: scw)
                let cfg = SCStreamConfiguration()
                cfg.width = width
                cfg.height = height
                cfg.showsCursor = false
                box.result = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg))
            } catch {
                box.result = .failure(error)
            }
            sem.signal()
        }
        if sem.wait(timeout: .now() + 8) == .timedOut { throw HelperError("capture timed out") }
        return try box.result.get()
    }

    /// JPEG (base64) of `image` with orange element boxes and ids; `origin`/`scale` map points to pixels.
    static func jpeg(_ image: CGImage, marks: [Json], origin: CGPoint, scale: CGFloat, quality: Int) -> String {
        let w = image.width, h = image.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return "" }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let orange = CGColor(red: 1, green: 0.45, blue: 0, alpha: 1)
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 11, nil)
        for m in marks {
            guard let x = m["x"] as? Int, let y = m["y"] as? Int, let mw = m["w"] as? Int, let mh = m["h"] as? Int, let id = m["id"] as? String else { continue }
            // CoreGraphics has a bottom-left origin.
            let r = CGRect(x: (CGFloat(x) - origin.x) * scale, y: CGFloat(h) - (CGFloat(y) - origin.y + CGFloat(mh)) * scale,
                           width: CGFloat(mw) * scale, height: CGFloat(mh) * scale)
            ctx.setStrokeColor(orange)
            ctx.setLineWidth(1.5)
            ctx.stroke(r)
            let text = NSAttributedString(string: id, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
            ])
            let line = CTLineCreateWithAttributedString(text)
            let tw = CTLineGetTypographicBounds(line, nil, nil, nil)
            ctx.setFillColor(orange)
            ctx.fill(CGRect(x: r.minX, y: r.maxY - 13, width: CGFloat(tw) + 4, height: 13))
            ctx.textPosition = CGPoint(x: r.minX + 2, y: r.maxY - 10)
            CTLineDraw(line, ctx)
        }
        guard let out = ctx.makeImage() else { return "" }
        let rep = NSBitmapImageRep(cgImage: out)
        let data = rep.representation(using: .jpeg, properties: [.compressionFactor: Double(quality) / 100]) ?? Data()
        return data.base64EncodedString()
    }
}

// MARK: - Input to one app (never the user's mouse/keyboard)

enum Input {
    static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "esc": 53, "escape": 53, "delete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
        "f11": 103, "f12": 111,
    ]

    static func key(pid: pid_t, keys: String, repeatCount: Int) throws {
        var flags: CGEventFlags = []
        var main: CGKeyCode?
        for part in keys.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init) {
            switch part {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "win", "windows": throw HelperError("there is no Windows key on a Mac: use cmd shortcuts")
            default:
                guard let code = keyCodes[part] else { throw HelperError("unknown key '\(part)'") }
                main = code
            }
        }
        guard let code = main else { throw HelperError("key combination needs one main key: \(keys)") }
        let src = CGEventSource(stateID: .privateState) // its own modifier state: the user's keys stay out of it
        for _ in 0..<max(1, repeatCount) {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
                e.flags = flags
                e.postToPid(pid)
            }
            usleep(30_000)
        }
    }

    static func text(pid: pid_t, _ text: String) {
        let src = CGEventSource(stateID: .privateState)
        for ch in text {
            if ch == "\n" { try? key(pid: pid, keys: "enter", repeatCount: 1); continue }
            if ch == "\t" { try? key(pid: pid, keys: "tab", repeatCount: 1); continue }
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e.postToPid(pid)
            }
            usleep(8_000)
        }
    }

    static func click(pid: pid_t, at p: CGPoint, double: Bool, right: Bool) {
        let (down, up): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        for n in 1...(double ? 2 : 1) {
            for t in [down, up] {
                guard let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: right ? .right : .left) else { continue }
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                e.postToPid(pid)
            }
        }
    }

    static func scroll(pid: pid_t, at p: CGPoint, amount: Int, horizontal: Bool) {
        guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                              wheel1: horizontal ? 0 : Int32(amount), wheel2: horizontal ? Int32(amount) : 0, wheel3: 0) else { return }
        e.location = p
        e.postToPid(pid)
    }
}

// MARK: - Commands

final class Helper {
    var target: WindowInfo?
    var live: [AXUIElement] = [] // elements of the last wobserve, index = id number - 1

    func element(_ id: String) -> AXUIElement? {
        guard id.hasPrefix("d"), let n = Int(id.dropFirst()), n >= 1, n <= live.count else { return nil }
        return live[n - 1]
    }

    func needTarget(_ req: Json) throws -> WindowInfo {
        if let h = int(req, "hwnd"), h != 0 { target = try Windows.find(h) }
        guard let t = target else { throw HelperError("no target window: observe it first") }
        return t
    }

    func point(_ req: Json, _ xk: String = "x", _ yk: String = "y") -> CGPoint? {
        guard let x = int(req, xk), let y = int(req, yk), x != Int(Int32.min), y != Int(Int32.min) else { return nil }
        return CGPoint(x: x, y: y)
    }

    func elementAt(_ p: CGPoint, pid: pid_t) -> AXUIElement? {
        var el: AXUIElement?
        return AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(p.x), Float(p.y), &el) == .success ? el : nil
    }

    func run(_ req: Json) throws -> Json {
        let cmd = str(req, "cmd")
        var res: Json = [:]
        switch cmd {
        case "ping":
            res["pong"] = true
        case "windows":
            res["windows"] = Windows.list().map { $0.json }
        case "foreground":
            res["window"] = Windows.foreground()?.json ?? ["hwnd": 0]
        case "cursor":
            let p = CGEvent(source: nil)?.location ?? .zero
            res["x"] = Int(p.x)
            res["y"] = Int(p.y)
        case "folders":
            let fm = FileManager.default
            func dir(_ d: FileManager.SearchPathDirectory) -> String { fm.urls(for: d, in: .userDomainMask).first?.path ?? "" }
            res["desktop"] = dir(.desktopDirectory)
            res["documents"] = dir(.documentDirectory)
            res["pictures"] = dir(.picturesDirectory)
            res["videos"] = dir(.moviesDirectory)
            res["downloads"] = dir(.downloadsDirectory)
            res["home"] = NSHomeDirectory()
        case "wobserve":
            try observe(req, &res)
        case "bgclick":
            res["method"] = try click(req)
        case "bgtype":
            res["method"] = try type(req)
        case "bgkey":
            let t = try needTarget(req)
            try Input.key(pid: t.pid, keys: str(req, "keys"), repeatCount: min(50, int(req, "repeat") ?? 1))
            res["method"] = "posted key \(str(req, "keys")) to the app (check the screen: some apps ignore keys while in the background)"
        case "bgscroll":
            let t = try needTarget(req)
            let p = point(req) ?? (element(str(req, "el")).flatMap(Ax.frame).map { CGPoint(x: $0.midX, y: $0.midY) }) ?? CGPoint(x: t.bounds.midX, y: t.bounds.midY)
            Input.scroll(pid: t.pid, at: p, amount: int(req, "amount") ?? -5, horizontal: bool(req, "horizontal"))
            res["method"] = "posted scroll"
        case "bgdrag":
            res["method"] = try drag(req)
        case "bgplace":
            if let h = int(req, "hwnd"), let w = try? Windows.find(h) { target = w; res["placed"] = true } else { res["placed"] = false }
        case "launch":
            let what = str(req, "target")
            if what.isEmpty { throw HelperError("launch needs target") }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            // -g: do not bring it to the front. An app name, else a URL or a path.
            let isApp = !what.contains("/") && !what.contains(":") && !what.contains(".")
            p.arguments = isApp ? ["-g", "-a", what] : ["-g", what]
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 { throw HelperError("could not open \(what)") }
            res["launched"] = what
        case "readtext":
            let t = try needTarget(req)
            let maxChars = min(200_000, int(req, "max") ?? 20_000)
            var root: AXUIElement? = Windows.axWindow(t)
            if let p = point(req), let el = elementAt(p, pid: t.pid) { root = el }
            guard let r = root else { throw HelperError("no Accessibility access to this window") }
            res["text"] = Ax.text(r, max: maxChars)
        case "filedialog":
            let t = try needTarget(req)
            let path = str(req, "path")
            if path.isEmpty { throw HelperError("filedialog needs path") }
            guard FileManager.default.fileExists(atPath: path) else { throw HelperError("no such file: \(path)") }
            let hasSheet: () -> Bool = {
                guard let win = Windows.axWindow(t), let kids = Ax.attr(win, kAXChildrenAttribute) as? [AXUIElement] else { return false }
                return kids.contains { Ax.string($0, kAXRoleAttribute) == "AXSheet" }
            }
            // The standard Open panel: "Go to folder" takes a full file path, return selects it,
            // a second return presses Open.
            try Input.key(pid: t.pid, keys: "cmd+shift+g", repeatCount: 1)
            usleep(600_000)
            Input.text(pid: t.pid, path)
            usleep(300_000)
            try Input.key(pid: t.pid, keys: "enter", repeatCount: 1)
            usleep(600_000)
            try Input.key(pid: t.pid, keys: "enter", repeatCount: 1)
            usleep(800_000)
            res["value"] = path
            res["button"] = "Open"
            res["closed"] = !hasSheet()
        case "close":
            let t = try needTarget(req)
            guard let win = Windows.axWindow(t), let btn = Ax.attr(win, kAXCloseButtonAttribute) else { throw HelperError("the window has no close button") }
            _ = AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString)
            res["closed"] = true
        default:
            throw HelperError("unknown cmd '\(cmd)' (the Mac helper has the background commands only)")
        }
        return res
    }

    func observe(_ req: Json, _ res: inout Json) throws {
        guard let h = int(req, "hwnd") else { throw HelperError("wobserve needs hwnd") }
        let w = try Windows.find(h)
        target = w
        let maxElements = max(0, min(300, int(req, "maxElements") ?? 150))
        let found = Windows.axWindow(w).map { Ax.collect($0, bounds: w.bounds, max: maxElements) } ?? []
        live = found.map { $0.0 }
        var elements = found.map { $0.1 }
        for i in elements.indices { elements[i]["id"] = "d\(i + 1)" }

        let maxWidth = max(640, min(2560, int(req, "maxWidth") ?? 1400))
        let scale = min(1.0, CGFloat(maxWidth) / w.bounds.width)
        let pw = max(1, Int((w.bounds.width * scale).rounded())), ph = max(1, Int((w.bounds.height * scale).rounded()))
        do {
            let img = try Capture.window(w, width: pw, height: ph)
            res["image"] = Capture.jpeg(img, marks: bool(req, "marks", true) ? elements : [], origin: w.bounds.origin, scale: scale,
                                        quality: max(30, min(95, int(req, "quality") ?? 70)))
            res["captured"] = true
        } catch {
            res["captured"] = false
            res["captureError"] = "\(error) — allow Screen Recording for this app in System Settings"
        }
        res["width"] = pw
        res["height"] = ph
        res["scale"] = Double(scale)
        res["screen"] = ["x": Int(w.bounds.minX), "y": Int(w.bounds.minY), "width": Int(w.bounds.width), "height": Int(w.bounds.height), "primary": true]
        res["screens"] = 1
        res["foreground"] = w.json // the TARGET window (not the user's foreground)
        res["userForeground"] = Windows.foreground()?.json ?? ["hwnd": 0]
        res["elements"] = elements
    }

    func click(_ req: Json) throws -> String {
        let t = try needTarget(req)
        let dbl = bool(req, "double"), right = bool(req, "right")
        var el = element(str(req, "el"))
        let p = point(req)
        if el == nil, let p = p { el = elementAt(p, pid: t.pid) }
        if let el = el, !right {
            let acts = Ax.actions(el)
            if dbl, acts.contains("AXOpen") {
                if AXUIElementPerformAction(el, "AXOpen" as CFString) == .success { return "opened" }
            }
            if acts.contains(kAXPressAction as String), AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
                if dbl { _ = AXUIElementPerformAction(el, kAXPressAction as CFString) }
                return "pressed"
            }
            if Ax.settable(el, kAXSelectedAttribute), AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return "selected" }
            if Ax.settable(el, kAXFocusedAttribute) { _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        }
        if right, let el = el, Ax.actions(el).contains(kAXShowMenuAction as String) {
            _ = AXUIElementPerformAction(el, kAXShowMenuAction as CFString)
            return "showed the context menu"
        }
        guard let at = p ?? el.flatMap(Ax.frame).map({ CGPoint(x: $0.midX, y: $0.midY) }) else { throw HelperError("unknown element id (ids change every turn)") }
        Input.click(pid: t.pid, at: at, double: dbl, right: right)
        return "posted \(dbl ? "double-click" : right ? "right-click" : "click") to the app"
    }

    func type(_ req: Json) throws -> String {
        let t = try needTarget(req)
        let text = str(req, "text"), clear = bool(req, "clear")
        if let el = element(str(req, "el")) {
            if Ax.settable(el, kAXValueAttribute) {
                let value = clear ? text : Ax.string(el, kAXValueAttribute) + text
                if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) == .success { return "set value" }
            }
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
        if clear { try? Input.key(pid: t.pid, keys: "cmd+a", repeatCount: 1) }
        Input.text(pid: t.pid, text)
        return "posted characters to the app"
    }

    func drag(_ req: Json) throws -> String {
        _ = try needTarget(req)
        guard let el = element(str(req, "el")), Ax.string(el, kAXRoleAttribute) == "AXSlider", let f = Ax.frame(el),
              let to = point(req, "x2", "y2") else {
            throw HelperError("on a Mac, drag works for sliders only (give \"from\" the slider's id); use buttons/menus instead")
        }
        let minV = (Ax.attr(el, kAXMinValueAttribute) as? NSNumber)?.doubleValue ?? 0
        let maxV = (Ax.attr(el, kAXMaxValueAttribute) as? NSNumber)?.doubleValue ?? 100
        let vertical = f.height > f.width
        var frac = vertical ? (f.maxY - to.y) / max(1, f.height) : (to.x - f.minX) / max(1, f.width)
        frac = max(0, min(1, frac))
        let v = NSNumber(value: minV + Double(frac) * (maxV - minV))
        guard AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, v) == .success else { throw HelperError("the slider did not accept a value") }
        return "set the slider value"
    }
}

// MARK: - Main loop

func reply(_ obj: Json) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

let axTrusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
let screenOK = CGPreflightScreenCaptureAccess()
if !screenOK { _ = CGRequestScreenCaptureAccess() }
reply(["ready": true, "version": 1, "platform": "mac", "accessibility": axTrusted, "screenRecording": screenOK])

let helper = Helper()
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    var res: Json
    var id: Any = NSNull()
    do {
        guard let req = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? Json else { throw HelperError("bad request") }
        id = req["id"] ?? NSNull()
        res = try helper.run(req)
        res["ok"] = true
    } catch {
        res = ["ok": false, "error": "\(error)"]
    }
    res["id"] = id
    reply(res)
}
