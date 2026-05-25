import Darwin
import Foundation

let appBundleID = "com.winterfell.nutshell"
let defaultIntervalSeconds = 900

struct AgentLog: Encodable {
  let timestamp: String
  let level: String
  let message: String
  let detail: [String: String]
}

func main() {
  writeLog("info", "agent started", [:])
  while true {
    autoreleasepool {
      if !syncEnabled() {
        writeLog("info", "sync disabled; sleeping", [:])
      } else if !fullDiskAccessGranted() {
        writeLog("warning", "Full Disk Access is not granted; sync skipped", ["bundleId": appBundleID])
      } else {
        runSync()
      }
    }
    Thread.sleep(forTimeInterval: TimeInterval(intervalSeconds()))
  }
}

func runSync() {
  guard let core = coreExecutable() else {
    writeLog("critical", "bundled nutshell-core is missing", [:])
    return
  }
  let started = Date()
  let result = runProcess(core.path, ["sync", "all", "--mode", "recent", "--json"])
  let elapsed = String(format: "%.3f", Date().timeIntervalSince(started))
  let level = result.code == 0 ? "info" : "error"
  writeLog(level, "sync finished", [
    "exit": String(result.code),
    "elapsedSeconds": elapsed,
    "outputPreview": String(result.output.prefix(800)),
  ])
}

func coreExecutable() -> URL? {
  let agentURL = currentExecutableURL()
  let appURL = agentURL
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let core = appURL.appendingPathComponent("Contents/Resources/nutshell-core")
  return FileManager.default.isExecutableFile(atPath: core.path) ? core : nil
}

func currentExecutableURL() -> URL {
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: Int(size))
  defer { buffer.deallocate() }
  if _NSGetExecutablePath(buffer, &size) == 0 {
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
  }
  return URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
}

func intervalSeconds() -> Int {
  let raw = ProcessInfo.processInfo.environment["NUTSHELL_AGENT_INTERVAL_SECONDS"] ?? ""
  guard let value = Int(raw), value > 0 else { return defaultIntervalSeconds }
  return value
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

func syncEnabled() -> Bool {
  FileManager.default.fileExists(atPath: syncMarker().path)
}

func syncMarker() -> URL {
  dataRoot().appendingPathComponent(".agent-sync-enabled")
}

func dataRoot() -> URL {
  if let root = ProcessInfo.processInfo.environment["NUTSHELL_ROOT"], !root.isEmpty {
    return URL(fileURLWithPath: NSString(string: root).expandingTildeInPath)
  }
  return homeDirectory().appendingPathComponent("Nutshell", isDirectory: true)
}

func logPath() -> URL {
  dataRoot().appendingPathComponent("logs/nutshell-agent.jsonl")
}

func writeLog(_ level: String, _ message: String, _ detail: [String: String]) {
  let encoder = JSONEncoder()
  let event = AgentLog(timestamp: isoNow(), level: level, message: message, detail: detail)
  guard let data = try? encoder.encode(event) else { return }
  var line = data
  line.append(0x0A)

  let path = logPath()
  try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
  if !FileManager.default.fileExists(atPath: path.path) {
    FileManager.default.createFile(atPath: path.path, contents: nil)
  }
  guard let handle = try? FileHandle(forWritingTo: path) else { return }
  defer { try? handle.close() }
  try? handle.seekToEnd()
  try? handle.write(contentsOf: line)
}

func isoNow() -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date())
}

struct ProcessResult {
  let code: Int32
  let output: String
}

func runProcess(_ executable: String, _ arguments: [String]) -> ProcessResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  var environment = ProcessInfo.processInfo.environment
  environment["NUTSHELL_APP_BUNDLE_ID"] = appBundleID
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

func homeDirectory() -> URL {
  FileManager.default.homeDirectoryForCurrentUser
}

main()
