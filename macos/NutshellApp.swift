import AppKit
import Foundation
import ServiceManagement

let appBundleID = "com.winterfell.nutshell"
let agentLabel = "com.winterfell.nutshell.agent"
let agentPlistName = "com.winterfell.nutshell.agent.plist"
let productName = "Nutshell"

enum AppError: Error, CustomStringConvertible {
  case unsupported(String)
  case missingBundleResource(String)
  case processFailed(String, Int32, String)

  var description: String {
    switch self {
    case .unsupported(let message):
      return message
    case .missingBundleResource(let name):
      return "Missing bundled resource: \(name)"
    case .processFailed(let command, let code, let output):
      return "\(command) failed with exit \(code)\n\(output)"
    }
  }
}

struct ProcessResult {
  let code: Int32
  let output: String
}

func usage() -> String {
  """
  Nutshell.app

  Commands:
    setup                   Open the guided macOS permission setup window.
    status                  Show helper and Full Disk Access status.
    register-agent          Register the app-owned background agent.
    unregister-agent        Unregister the app-owned background agent.
    enable-sync             Enable background sync after Full Disk Access is granted.
    disable-sync            Disable background sync without unregistering the agent.
    open-full-disk-access   Open macOS Full Disk Access settings.
    verify                  Run Nutshell health through the bundled core.

  The CLI should call this app for protected Mac access. Do not run protected sync
  from Homebrew, Bun, Terminal, or temporary build paths in production.
  """
}

var retainedOnboardingDelegate: OnboardingAppDelegate?

func main() throws {
  guard let command = requestedCommand() else {
    runOnboardingApp()
    return
  }
  switch command {
  case "help", "--help", "-h":
    print(usage())
  case "setup", "onboard":
    runOnboardingApp()
  case "status":
    try printStatus()
  case "register-agent":
    try registerAgent()
  case "unregister-agent":
    try unregisterAgent()
  case "enable-sync":
    try enableSync()
  case "disable-sync":
    try disableSync()
  case "open-full-disk-access":
    openFullDiskAccess()
  case "verify":
    try verify()
  case "__sync-once":
    try syncOnce()
  default:
    throw AppError.unsupported("Unknown Nutshell.app command: \(command)\n\n\(usage())")
  }
}

func requestedCommand() -> String? {
  guard let first = CommandLine.arguments.dropFirst().first else { return nil }
  return first.hasPrefix("-psn_") ? nil : first
}

func printStatus() throws {
  print("App: \(Bundle.main.bundleURL.path)")
  print("Bundle ID: \(Bundle.main.bundleIdentifier ?? "unknown")")
  print("Agent: \(agentLabel)")
  print("Agent status: \(agentStatusText())")
  print("Full Disk Access: \(fullDiskAccessGranted() ? "granted" : "not granted")")
  print("Background sync: \(syncEnabled() ? "enabled" : "disabled")")
  print("Data root: \(dataRoot().path)")
}

func registerAgent() throws {
  if #available(macOS 13.0, *) {
    try SMAppService.agent(plistName: agentPlistName).register()
    print("registered \(agentLabel)")
    print("Agent status: \(agentStatusText())")
    if !fullDiskAccessGranted() {
      print("Full Disk Access is not granted. Run `Nutshell.app open-full-disk-access`, grant access to Nutshell.app, then run `Nutshell.app enable-sync`.")
    }
  } else {
    throw AppError.unsupported("SMAppService requires macOS 13 or newer.")
  }
}

func unregisterAgent() throws {
  if #available(macOS 13.0, *) {
    try SMAppService.agent(plistName: agentPlistName).unregister()
    try? removeSyncMarker()
    print("unregistered \(agentLabel)")
  } else {
    throw AppError.unsupported("SMAppService requires macOS 13 or newer.")
  }
}

func enableSync() throws {
  if !fullDiskAccessGranted() {
    openFullDiskAccess()
    throw AppError.unsupported("Full Disk Access is not granted to \(productName). Grant it, then run enable-sync again.")
  }
  try FileManager.default.createDirectory(at: dataRoot(), withIntermediateDirectories: true)
  try "enabled\n".write(to: syncMarker(), atomically: true, encoding: .utf8)
  print("background sync enabled")
}

func disableSync() throws {
  try? removeSyncMarker()
  print("background sync disabled")
}

func verify() throws {
  let result = try runCore(["health", "--json"])
  print(result.output)
  if result.code != 0 {
    throw AppError.processFailed("nutshell-core health", result.code, result.output)
  }
}

func syncOnce() throws {
  if !fullDiskAccessGranted() {
    throw AppError.unsupported("Full Disk Access is not granted to \(productName).")
  }
  let source = CommandLine.arguments.dropFirst(2).first ?? "all"
  let result = try runCore(["sync", source, "--mode", "recent", "--json"])
  print(result.output)
  if result.code >= 2 {
    throw AppError.processFailed("nutshell-core sync \(source)", result.code, result.output)
  }
}

func agentStatusText() -> String {
  if #available(macOS 13.0, *) {
    switch SMAppService.agent(plistName: agentPlistName).status {
    case .notRegistered:
      return "notRegistered"
    case .enabled:
      return "enabled"
    case .requiresApproval:
      return "requiresApproval"
    case .notFound:
      return "notFound"
    @unknown default:
      return "unknown"
    }
  }
  return "unsupported"
}

func openFullDiskAccess() {
  let urls = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "x-apple.systempreferences:com.apple.preference.security",
  ]
  for value in urls {
    guard let url = URL(string: value) else { continue }
    if NSWorkspace.shared.open(url) { return }
  }
}

func runCore(_ arguments: [String]) throws -> ProcessResult {
  guard let core = Bundle.main.url(forResource: "nutshell-core", withExtension: nil) else {
    throw AppError.missingBundleResource("nutshell-core")
  }
  return runProcess(core.path, arguments)
}

func runProcess(_ executable: String, _ arguments: [String]) -> ProcessResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  var environment = ProcessInfo.processInfo.environment
  environment["NUTSHELL_APP_BUNDLE_ID"] = appBundleID
  environment["NUTSHELL_APP_PATH"] = Bundle.main.bundleURL.path
  process.environment = environment

  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe
  do {
    try process.run()
  } catch {
    return ProcessResult(code: 127, output: String(describing: error))
  }
  process.waitUntilExit()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  return ProcessResult(code: process.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
}

func fullDiskAccessGranted() -> Bool {
  if tccDatabaseGrantsFullDiskAccess(systemTccDatabase()) { return true }
  if tccDatabaseGrantsFullDiskAccess(userTccDatabase()) { return true }
  return false
}

func tccDatabaseGrantsFullDiskAccess(_ db: URL) -> Bool {
  guard FileManager.default.fileExists(atPath: db.path) else { return false }
  let query = """
  select auth_value from access
  where service='kTCCServiceSystemPolicyAllFiles'
    and client='\(appBundleID)'
    and client_type=0
  order by last_modified desc
  limit 1;
  """
  let result = runProcess("/usr/bin/sqlite3", [db.path, query])
  let value = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
  return value == "2" || value == "1"
}

func userTccDatabase() -> URL {
  homeDirectory().appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
}

func systemTccDatabase() -> URL {
  URL(fileURLWithPath: "/Library/Application Support/com.apple.TCC/TCC.db")
}

func dataRoot() -> URL {
  if let root = ProcessInfo.processInfo.environment["NUTSHELL_ROOT"], !root.isEmpty {
    return URL(fileURLWithPath: NSString(string: root).expandingTildeInPath)
  }
  return homeDirectory().appendingPathComponent("Nutshell", isDirectory: true)
}

func syncMarker() -> URL {
  dataRoot().appendingPathComponent(".agent-sync-enabled")
}

func syncEnabled() -> Bool {
  FileManager.default.fileExists(atPath: syncMarker().path)
}

func removeSyncMarker() throws {
  if FileManager.default.fileExists(atPath: syncMarker().path) {
    try FileManager.default.removeItem(at: syncMarker())
  }
}

func homeDirectory() -> URL {
  FileManager.default.homeDirectoryForCurrentUser
}

func runOnboardingApp() {
  let app = NSApplication.shared
  let delegate = OnboardingAppDelegate()
  retainedOnboardingDelegate = delegate
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}

final class OnboardingAppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private var refreshTimer: Timer?

  private let accessValue = NSTextField(labelWithString: "")
  private let agentValue = NSTextField(labelWithString: "")
  private let syncValue = NSTextField(labelWithString: "")
  private let messageValue = NSTextField(labelWithString: "")
  private let finishButton = NSButton(title: "Enable background sync", target: nil, action: nil)

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildWindow()
    refreshStatus()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
    window?.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    refreshTimer?.invalidate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 620, height: 560),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Nutshell Setup"
    window.center()
    window.isReleasedWhenClosed = false

    let content = NSView()
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    window.contentView = content

    let root = NSStackView()
    root.orientation = .vertical
    root.alignment = .leading
    root.spacing = 18
    root.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(root)

    let title = label("Finish Nutshell Setup", size: 24, weight: .semibold)
    let intro = wrappingLabel(
      "Nutshell needs Full Disk Access before the background helper can read protected local data like Podcasts and browser-owned files. macOS will not let an app grant that permission for you, but this window opens the right Settings page and gives you the exact app icon to drag into the list."
    )

    root.addArrangedSubview(title)
    root.addArrangedSubview(intro)
    root.addArrangedSubview(statusBox())
    root.addArrangedSubview(dragBox())
    root.addArrangedSubview(buttonRow())

    messageValue.maximumNumberOfLines = 3
    messageValue.lineBreakMode = .byWordWrapping
    messageValue.font = NSFont.systemFont(ofSize: 12)
    messageValue.textColor = .secondaryLabelColor
    root.addArrangedSubview(messageValue)

    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      root.topAnchor.constraint(equalTo: content.topAnchor, constant: 26),
      root.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
    ])

    self.window = window
  }

  private func statusBox() -> NSView {
    let box = NSBox()
    box.title = ""
    box.boxType = .custom
    box.borderType = .lineBorder
    box.cornerRadius = 10
    box.contentViewMargins = NSSize(width: 16, height: 14)

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false

    stack.addArrangedSubview(statusLine("Full Disk Access", accessValue))
    stack.addArrangedSubview(statusLine("Background helper", agentValue))
    stack.addArrangedSubview(statusLine("Background sync", syncValue))

    box.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor),
      stack.topAnchor.constraint(equalTo: box.contentView!.topAnchor),
      stack.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor),
      box.widthAnchor.constraint(equalToConstant: 564),
    ])
    return box
  }

  private func dragBox() -> NSView {
    let box = NSBox()
    box.title = ""
    box.boxType = .custom
    box.borderType = .lineBorder
    box.cornerRadius = 10
    box.contentViewMargins = NSSize(width: 16, height: 16)

    let stack = NSStackView()
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false

    let icon = DraggableAppIconView(appURL: Bundle.main.bundleURL)
    icon.image = NSWorkspace.shared.icon(forFile: Bundle.main.bundleURL.path)
    icon.imageScaling = .scaleProportionallyUpOrDown
    icon.toolTip = "Drag Nutshell.app into the Full Disk Access list."
    icon.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      icon.widthAnchor.constraint(equalToConstant: 74),
      icon.heightAnchor.constraint(equalToConstant: 74),
    ])

    let copy = NSStackView()
    copy.orientation = .vertical
    copy.alignment = .leading
    copy.spacing = 5
    copy.addArrangedSubview(label("Drag Nutshell.app into Full Disk Access", size: 15, weight: .semibold))
    copy.addArrangedSubview(wrappingLabel("If Nutshell is not already listed in System Settings, drag the app icon from this window into the Full Disk Access list, then turn its switch on."))

    stack.addArrangedSubview(icon)
    stack.addArrangedSubview(copy)

    box.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor),
      stack.topAnchor.constraint(equalTo: box.contentView!.topAnchor),
      stack.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor),
      box.widthAnchor.constraint(equalToConstant: 564),
    ])
    return box
  }

  private func buttonRow() -> NSView {
    let stack = NSStackView()
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 10

    let openButton = NSButton(title: "Open Full Disk Access", target: self, action: #selector(openAccessSettings))
    let revealButton = NSButton(title: "Reveal App", target: self, action: #selector(revealApp))
    let checkButton = NSButton(title: "Check Again", target: self, action: #selector(checkAgain))

    finishButton.target = self
    finishButton.action = #selector(finishSetup)
    finishButton.bezelStyle = .rounded

    for button in [openButton, revealButton, checkButton, finishButton] {
      button.bezelStyle = .rounded
      stack.addArrangedSubview(button)
    }
    return stack
  }

  private func statusLine(_ title: String, _ value: NSTextField) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .firstBaseline
    row.spacing = 12

    let titleField = label(title, size: 12, weight: .medium)
    titleField.textColor = .secondaryLabelColor
    titleField.translatesAutoresizingMaskIntoConstraints = false
    titleField.widthAnchor.constraint(equalToConstant: 150).isActive = true

    value.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    value.textColor = .labelColor

    row.addArrangedSubview(titleField)
    row.addArrangedSubview(value)
    return row
  }

  @objc private func openAccessSettings() {
    openFullDiskAccess()
    showMessage("System Settings is open. Add or enable Nutshell.app in Full Disk Access, then come back here. This window will notice automatically.")
  }

  @objc private func revealApp() {
    NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
  }

  @objc private func checkAgain() {
    refreshStatus()
  }

  @objc private func finishSetup() {
    do {
      if agentStatusText() != "enabled" {
        try registerAgent()
      }
      try enableSync()
      refreshStatus()
      showMessage("Nutshell background sync is enabled.")
    } catch {
      refreshStatus()
      showMessage("\(error)", isError: true)
    }
  }

  private func refreshStatus() {
    let accessGranted = fullDiskAccessGranted()
    let agentStatus = agentStatusText()
    let enabled = syncEnabled()

    accessValue.stringValue = accessGranted ? "granted" : "not granted"
    accessValue.textColor = accessGranted ? .systemGreen : .systemRed
    agentValue.stringValue = agentStatus
    syncValue.stringValue = enabled ? "enabled" : "disabled"
    syncValue.textColor = enabled ? .systemGreen : .secondaryLabelColor
    finishButton.isEnabled = accessGranted && !enabled
    finishButton.title = enabled ? "Background sync enabled" : "Enable background sync"

    if accessGranted && enabled {
      showMessage("Setup is complete. You can close this window.")
    } else if accessGranted {
      showMessage("Full Disk Access is granted. Enable background sync when you are ready.")
    } else if messageValue.stringValue.isEmpty {
      showMessage("Open Full Disk Access, drag Nutshell.app into the list if needed, and turn it on.")
    }
  }

  private func showMessage(_ text: String, isError: Bool = false) {
    messageValue.stringValue = text
    messageValue.textColor = isError ? .systemRed : .secondaryLabelColor
  }
}

final class DraggableAppIconView: NSImageView, NSDraggingSource {
  private let appURL: URL

  init(appURL: URL) {
    self.appURL = appURL
    super.init(frame: .zero)
    isEditable = false
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func mouseDown(with event: NSEvent) {
    let draggingItem = NSDraggingItem(pasteboardWriter: appURL as NSURL)
    draggingItem.setDraggingFrame(bounds, contents: image)
    beginDraggingSession(with: [draggingItem], event: event, source: self)
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    .copy
  }
}

func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSTextField {
  let field = NSTextField(labelWithString: text)
  field.font = NSFont.systemFont(ofSize: size, weight: weight)
  field.textColor = .labelColor
  field.lineBreakMode = .byTruncatingTail
  return field
}

func wrappingLabel(_ text: String) -> NSTextField {
  let field = NSTextField(wrappingLabelWithString: text)
  field.font = NSFont.systemFont(ofSize: 13)
  field.textColor = .secondaryLabelColor
  field.maximumNumberOfLines = 0
  field.lineBreakMode = .byWordWrapping
  return field
}

do {
  try main()
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}
