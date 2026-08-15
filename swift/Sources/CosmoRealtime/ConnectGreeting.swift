import Foundation

/// Cosmo's self-introduction on connect, in the two shapes its two delivery
/// channels require. They are not interchangeable: `session.greeting` is voiced
/// verbatim server-side (`first_message` → "say exactly this"), so a directive
/// sent there is read aloud instead of followed.
public enum ConnectGreeting {
    /// Verbatim opening line for ``SessionConfig/greeting``. Spoken as written,
    /// so it is speech and never an instruction. Greets by the first word of
    /// the name that isn't an abbreviation, which suits western given-name-first
    /// names; a name written as one word (many CJK names) is spoken whole.
    public static func openingLine(userDisplayName: String?) -> String {
        guard let name = usableName(userDisplayName) else { return "Cosmo here!" }
        let words = name.split(separator: " ")
        let spoken = (words.first { !$0.hasSuffix(".") } ?? words[0])
            .trimmingCharacters(in: trailingPunctuation)
        guard !spoken.isEmpty else { return "Cosmo here!" }
        return "Hey \(spoken), Cosmo here!"
    }

    /// First-turn directive for hosts that open with a text turn instead of the
    /// config greeting (iOS), where the model composes the line rather
    /// than reciting it.
    public static let instruction: String =
        "Greet in 2-4 words, naming yourself Cosmo — like \"Cosmo here!\" or \"Hey, it's Cosmo.\" Then stop and wait."

    /// How the model should use the user's name, for ``SessionConfig/speakingStyle``
    /// — the server appends it to whatever persona it built, so it needs no
    /// host prompt to attach to and it survives a catalog agent's stored
    /// config. The name rides here rather than the opening line because it
    /// governs every turn, and the opening line is spoken verbatim.
    ///
    /// A dictation session is never given the name at all: it types
    /// what it hears, so the name has nothing to do there and the boundary
    /// clause below only steers. Withholding it keeps that surface name-free
    /// by construction rather than by prompt.
    ///
    /// The "occasionally / when it feels natural" wording is intentional:
    /// instructing the model to use the name freely makes it sycophantic
    /// ("Sure, Utkarsh!" every turn). Scoping it to spoken replies is too —
    /// without the boundary the model interpolates the name into text it types
    /// or dictates into the user's apps via the conversational dictate tools.
    public static func nameDirective(userDisplayName: String?, dictation: Bool) -> String? {
        guard !dictation, let name = usableName(userDisplayName) else { return nil }
        return """
        The user's name is "\(name)". Address them by name occasionally in \
        spoken replies when it feels natural — never insert their name into \
        text you type or dictate into their apps unless they actually said it.
        """
    }

    /// The display name reduced to what is safe to speak and to embed in the
    /// persona: control characters and quotes dropped, whitespace runs
    /// collapsed to single spaces, length capped. `nil` when nothing usable is
    /// left. Hosts are expected to sanitize (macOS does), but this is a public
    /// entry point and the name lands in `instructions` — an unfiltered one
    /// could forge a section break or a quote boundary in the prompt.
    private static func usableName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let cleaned = raw
            .components(separatedBy: .controlCharacters).joined(separator: " ")
            .replacingOccurrences(of: "\"", with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(maxNameLength))
    }

    /// Long enough for a full name, short enough that a crafted one can't
    /// carry a paragraph into the persona or a sentence into spoken audio.
    private static let maxNameLength = 64

    private static let trailingPunctuation = CharacterSet(charactersIn: ",.")
}
