import AppKit
import AVFoundation
import Darwin
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

struct AppCommandResult: Encodable {
  let code: Int32
  let stdout: String
  let stderr: String
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
    health                  Run app-owned health through the bundled core.
    doctor                  Run app-owned source doctor through the bundled core.
    sync                    Run app-owned sync through the bundled core.

  The CLI should call this app for protected Mac access. Do not run protected sync
  from Homebrew, Bun, Terminal, or temporary build paths in production.
  """
}

var retainedOnboardingDelegate: OnboardingAppDelegate?
let appCommandResultFile = resultFilePath(from: CommandLine.arguments)

func main() throws {
  guard let command = requestedCommand() else {
    runOnboardingApp()
    return
  }
  let output: String
  switch command {
  case "help", "--help", "-h":
    output = usage()
  case "setup", "onboard":
    runOnboardingApp()
    return
  case "status":
    output = try statusText()
  case "register-agent":
    output = try registerAgent()
  case "unregister-agent":
    output = try unregisterAgent()
  case "enable-sync":
    output = try enableSync()
  case "disable-sync":
    output = try disableSync()
  case "open-full-disk-access":
    output = openFullDiskAccess() ? "opened Full Disk Access settings\n" : "could not open Full Disk Access settings\n"
  case "verify":
    output = try verify()
  case "health", "doctor", "sync":
    try emit(try runCore(commandArguments(), timeoutSeconds: coreTimeoutSeconds(for: command)))
    return
  case "__sync-once":
    output = try syncOnce()
  default:
    throw AppError.unsupported("Unknown Nutshell.app command: \(command)\n\n\(usage())")
  }
  try emit(output)
}

func requestedCommand() -> String? {
  guard let first = commandArguments().first else { return nil }
  return first.hasPrefix("-psn_") ? nil : first
}

func commandArguments() -> [String] {
  var output: [String] = []
  var skipNext = false
  for argument in CommandLine.arguments.dropFirst() {
    if skipNext {
      skipNext = false
      continue
    }
    if argument == "--result-file" {
      skipNext = true
      continue
    }
    output.append(argument)
  }
  return output
}

func resultFilePath(from arguments: [String]) -> String? {
  for (index, argument) in arguments.enumerated() where argument == "--result-file" {
    guard index + 1 < arguments.count else { return nil }
    return NSString(string: arguments[index + 1]).expandingTildeInPath
  }
  return nil
}

func emit(_ stdout: String) throws {
  if let path = appCommandResultFile {
    try writeCommandResult(AppCommandResult(code: 0, stdout: stdout, stderr: ""), to: path)
    return
  }
  FileHandle.standardOutput.write(Data(stdout.utf8))
}

func emit(_ result: ProcessResult) throws {
  if let path = appCommandResultFile {
    try writeCommandResult(AppCommandResult(code: result.code, stdout: result.output, stderr: ""), to: path)
    return
  }
  FileHandle.standardOutput.write(Data(result.output.utf8))
  exit(result.code)
}

func writeCommandResult(_ result: AppCommandResult, to path: String) throws {
  let url = URL(fileURLWithPath: path)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let data = try JSONEncoder().encode(result)
  try data.write(to: url, options: .atomic)
}

func statusText() throws -> String {
  [
    "App: \(Bundle.main.bundleURL.path)",
    "Bundle ID: \(Bundle.main.bundleIdentifier ?? "unknown")",
    "Agent: \(agentLabel)",
    "Agent status: \(agentStatusText())",
    "Full Disk Access: \(fullDiskAccessGranted() ? "granted" : "not granted")",
    "Background sync: \(syncEnabled() ? "enabled" : "disabled")",
    "Data root: \(dataRoot().path)",
  ].joined(separator: "\n") + "\n"
}

func registerAgent() throws -> String {
  if #available(macOS 13.0, *) {
    try SMAppService.agent(plistName: agentPlistName).register()
    var lines = [
      "registered \(agentLabel)",
      "Agent status: \(agentStatusText())",
    ]
    if !fullDiskAccessGranted() {
      lines.append("Full Disk Access is not granted. Run `Nutshell.app open-full-disk-access`, grant access to Nutshell.app, then run `Nutshell.app enable-sync`.")
    }
    return lines.joined(separator: "\n") + "\n"
  } else {
    throw AppError.unsupported("SMAppService requires macOS 13 or newer.")
  }
}

func unregisterAgent() throws -> String {
  if #available(macOS 13.0, *) {
    try SMAppService.agent(plistName: agentPlistName).unregister()
    try? removeSyncMarker()
    return "unregistered \(agentLabel)\n"
  } else {
    throw AppError.unsupported("SMAppService requires macOS 13 or newer.")
  }
}

func enableSync() throws -> String {
  if !fullDiskAccessGranted() {
    _ = openFullDiskAccess()
    throw AppError.unsupported("Full Disk Access is not granted to \(productName). Grant it, then run enable-sync again.")
  }
  try FileManager.default.createDirectory(at: dataRoot(), withIntermediateDirectories: true)
  try "enabled\n".write(to: syncMarker(), atomically: true, encoding: .utf8)
  return "background sync enabled\n"
}

func disableSync() throws -> String {
  try? removeSyncMarker()
  return "background sync disabled\n"
}

func verify() throws -> String {
  let result = try runCore(["health", "--json"])
  if result.code != 0 {
    throw AppError.processFailed("nutshell-core health", result.code, result.output)
  }
  return result.output
}

func syncOnce() throws -> String {
  if !fullDiskAccessGranted() {
    throw AppError.unsupported("Full Disk Access is not granted to \(productName).")
  }
  let source = commandArguments().dropFirst().first ?? "all"
  let result = try runCore(["sync", source, "--mode", "recent", "--json"], timeoutSeconds: 120)
  if result.code >= 2 {
    throw AppError.processFailed("nutshell-core sync \(source)", result.code, result.output)
  }
  return result.output
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

func openFullDiskAccess() -> Bool {
  let urls = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "x-apple.systempreferences:com.apple.preference.security",
  ]
  for value in urls {
    guard let url = URL(string: value) else { continue }
    if NSWorkspace.shared.open(url) { return true }
  }
  return false
}

func runCore(_ arguments: [String], timeoutSeconds: TimeInterval? = nil) throws -> ProcessResult {
  guard let core = Bundle.main.url(forResource: "nutshell-core", withExtension: nil) else {
    throw AppError.missingBundleResource("nutshell-core")
  }
  return runProcess(core.path, arguments, timeoutSeconds: timeoutSeconds)
}

func coreTimeoutSeconds(for command: String) -> TimeInterval {
  switch command {
  case "health", "doctor":
    return 55
  case "sync":
    return 10 * 60
  default:
    return 55
  }
}

func runProcess(_ executable: String, _ arguments: [String], timeoutSeconds: TimeInterval? = nil, extraEnvironment: [String: String] = [:]) -> ProcessResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  var environment = ProcessInfo.processInfo.environment
  environment["NUTSHELL_APP_BUNDLE_ID"] = appBundleID
  environment["NUTSHELL_APP_PATH"] = Bundle.main.bundleURL.path
  for (key, value) in extraEnvironment {
    environment[key] = value
  }
  process.environment = environment

  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe
  do {
    try process.run()
  } catch {
    return ProcessResult(code: 127, output: String(describing: error))
  }
  if let timeoutSeconds {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while process.isRunning && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.1)
    }
    if process.isRunning {
      process.terminate()
      Thread.sleep(forTimeInterval: 2.0)
      if process.isRunning {
        kill(process.processIdentifier, SIGKILL)
      }
      process.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      let output = String(data: data, encoding: .utf8) ?? ""
      return ProcessResult(code: 124, output: "\(output)\nnutshell-core timed out after \(Int(timeoutSeconds))s")
    }
  } else {
    process.waitUntilExit()
  }
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
  private var backgroundPlayer: AVPlayer?
  private var backgroundLoopObserver: NSObjectProtocol?

  private let accessValue = NSTextField(labelWithString: "")
  private let messageValue = NSTextField(labelWithString: "")
  private let helpTitle = label("", size: 15, weight: .semibold)
  private let helpBody = wrappingLabel("")
  private let openButton = PointerButton(title: "Open Full Disk Access", target: nil, action: nil)
  private let revealButton = PointerButton(title: "Reveal App", target: nil, action: nil)
  private let checkButton = PointerButton(title: "Check Again", target: nil, action: nil)

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
    if let backgroundLoopObserver {
      NotificationCenter.default.removeObserver(backgroundLoopObserver)
    }
    backgroundPlayer?.pause()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 520),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Nutshell Setup"
    window.center()
    window.isReleasedWhenClosed = false

    let content = NSView()
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor.black.cgColor
    window.contentView = content
    addVideoBackground(to: content)

    let title = label("Setup Nutshell Permissions", size: 22, weight: .semibold)
    title.textColor = .white
    let intro = wrappingLabel(
      "Nutshell needs Full Disk Access before the background helper can read protected local data like Podcasts and browser-owned files."
    )
    intro.textColor = NSColor.white.withAlphaComponent(0.84)

    let left = NSStackView()
    left.orientation = .vertical
    left.alignment = .leading
    left.spacing = 12
    left.translatesAutoresizingMaskIntoConstraints = false
    left.addArrangedSubview(title)
    left.addArrangedSubview(intro)
    let status = statusBox()
    left.addArrangedSubview(status)
    left.setCustomSpacing(22, after: intro)

    let right = NSStackView()
    right.orientation = .vertical
    right.alignment = .leading
    right.spacing = 10
    right.translatesAutoresizingMaskIntoConstraints = false
    right.addArrangedSubview(dragBox())
    right.addArrangedSubview(buttonRow())

    messageValue.maximumNumberOfLines = 3
    messageValue.lineBreakMode = .byWordWrapping
    messageValue.font = NSFont.systemFont(ofSize: 12)
    messageValue.textColor = .secondaryLabelColor
    right.addArrangedSubview(messageValue)

    content.addSubview(left)
    content.addSubview(right)

    NSLayoutConstraint.activate([
      left.widthAnchor.constraint(equalToConstant: 450),
      right.widthAnchor.constraint(equalToConstant: 360),
      left.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 36),
      left.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -34),
      left.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 220),
      right.leadingAnchor.constraint(equalTo: left.trailingAnchor, constant: 26),
      right.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      right.bottomAnchor.constraint(equalTo: left.bottomAnchor),
    ])

    self.window = window
  }

  private func statusBox() -> NSView {
    let row = statusLine("Full Disk Access", accessValue)
    row.translatesAutoresizingMaskIntoConstraints = false
    row.widthAnchor.constraint(equalToConstant: 450).isActive = true
    return row
  }

  private func dragBox() -> NSView {
    let box = NSBox()
    styleCard(box)
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
    copy.addArrangedSubview(helpTitle)
    copy.addArrangedSubview(helpBody)

    stack.addArrangedSubview(icon)
    stack.addArrangedSubview(copy)

    box.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor),
      stack.topAnchor.constraint(equalTo: box.contentView!.topAnchor),
      stack.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor),
      box.widthAnchor.constraint(equalToConstant: 360),
    ])
    return box
  }

  private func buttonRow() -> NSView {
    let stack = NSStackView()
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 10

    openButton.target = self
    openButton.action = #selector(openAccessSettings)
    revealButton.target = self
    revealButton.action = #selector(revealApp)
    checkButton.target = self
    checkButton.action = #selector(checkAgain)

    for button in [openButton, revealButton, checkButton] {
      button.styleForVideoOverlay()
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
    titleField.textColor = NSColor.white.withAlphaComponent(0.68)
    titleField.translatesAutoresizingMaskIntoConstraints = false
    titleField.widthAnchor.constraint(equalToConstant: 150).isActive = true

    value.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    value.textColor = .white

    row.addArrangedSubview(titleField)
    row.addArrangedSubview(value)
    return row
  }

  @objc private func openAccessSettings() {
    _ = openFullDiskAccess()
    showMessage("System Settings is open. Add or enable Nutshell.app in Full Disk Access, then come back here. This window will notice automatically.")
  }

  @objc private func revealApp() {
    NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
  }

  @objc private func checkAgain() {
    refreshStatus()
  }

  private func refreshStatus() {
    let accessGranted = fullDiskAccessGranted()

    accessValue.stringValue = accessGranted ? "granted" : "not granted"
    accessValue.textColor = accessGranted ? .systemGreen : .systemRed
    openButton.isHidden = accessGranted
    revealButton.isHidden = accessGranted
    checkButton.isHidden = accessGranted

    if accessGranted {
      helpTitle.stringValue = "You're good."
      helpBody.stringValue = "You can safely close this window. Return to the terminal."
      helpTitle.textColor = .white
      helpBody.textColor = NSColor.white.withAlphaComponent(0.86)
      messageValue.isHidden = true
    } else {
      helpTitle.stringValue = "Grant Nutshell Full Disk Access"
      helpBody.stringValue = "Drag the Nutshell app icon into Full Disk Access if it is missing, then turn its switch on."
      helpTitle.textColor = .white
      helpBody.textColor = NSColor.white.withAlphaComponent(0.78)
      messageValue.isHidden = false
    }

    if !accessGranted && messageValue.stringValue.isEmpty {
      showMessage("Open Full Disk Access, drag Nutshell.app into the list if needed, and turn it on.")
    }
  }

  private func showMessage(_ text: String, isError: Bool = false) {
    messageValue.stringValue = text
    messageValue.textColor = isError ? .systemRed : NSColor.white.withAlphaComponent(0.74)
  }

  private func addVideoBackground(to view: NSView) {
    guard let url = Bundle.main.url(forResource: "nutshell-ascii-animation", withExtension: "mp4") else { return }
    let player = AVPlayer(url: url)
    player.isMuted = true
    player.actionAtItemEnd = .none

    let playerLayer = AVPlayerLayer(player: player)
    playerLayer.videoGravity = .resizeAspectFill
    playerLayer.frame = view.bounds
    playerLayer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
    view.layer?.addSublayer(playerLayer)

    let overlay = CALayer()
    overlay.backgroundColor = NSColor.black.withAlphaComponent(0.28).cgColor
    overlay.frame = view.bounds
    overlay.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
    view.layer?.addSublayer(overlay)

    backgroundLoopObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: player.currentItem,
      queue: .main
    ) { _ in
      player.seek(to: .zero)
      player.play()
    }
    backgroundPlayer = player
    player.play()
  }

  private func styleCard(_ box: NSBox) {
    box.title = ""
    box.boxType = .custom
    box.borderType = .lineBorder
    box.cornerRadius = 10
    box.fillColor = NSColor.black.withAlphaComponent(0.42)
    box.borderColor = NSColor.white.withAlphaComponent(0.28)
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

  override func resetCursorRects() {
    super.resetCursorRects()
    addCursorRect(bounds, cursor: .pointingHand)
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    .copy
  }
}

final class PointerButton: NSButton {
  override var intrinsicContentSize: NSSize {
    let base = super.intrinsicContentSize
    return NSSize(width: base.width + 26, height: max(34, base.height + 14))
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    addCursorRect(bounds, cursor: .pointingHand)
  }

  override func layout() {
    super.layout()
    layer?.cornerRadius = 8
  }

  func styleForVideoOverlay() {
    isBordered = false
    setButtonType(.momentaryChange)
    font = NSFont.systemFont(ofSize: 12, weight: .medium)
    alignment = .center
    lineBreakMode = .byTruncatingTail
    attributedTitle = NSAttributedString(
      string: title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: .medium),
        .foregroundColor: NSColor.white.withAlphaComponent(0.94),
      ]
    )
    wantsLayer = true
    layer?.cornerRadius = 8
    layer?.backgroundColor = NSColor.black.withAlphaComponent(0.36).cgColor
    layer?.borderWidth = 1
    layer?.borderColor = NSColor.white.withAlphaComponent(0.5).cgColor
    setContentHuggingPriority(.required, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .horizontal)
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
  let message = "\(error)\n"
  if let path = appCommandResultFile {
    try? writeCommandResult(AppCommandResult(code: 1, stdout: "", stderr: message), to: path)
  } else {
    fputs(message, stderr)
  }
  exit(1)
}
