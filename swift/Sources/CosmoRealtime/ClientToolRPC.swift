import Foundation

/// Resolves one client-tool ``perform_rpc`` invocation: given the tool
/// ``method`` name and the raw request ``payload`` (the worker's
/// ``json.dumps(args)``), returns the reply payload string the worker parses
/// into its ``ClientReply`` (``{ok, result, error}``).
///
/// JSONValue-agnostic by design: the SDK owns LiveKit registration only.
/// Argument decoding, tool execution, and reply encoding live in the app
/// layer, alongside the tool implementations and their ``JSONValue`` type.
public typealias ClientToolRPCHandler =
    @Sendable (_ method: String, _ payload: String) async -> String
