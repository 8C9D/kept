import Foundation

/// The export job wire shapes (server/src/routes/exports.ts), added
/// 2026-08-28 when the owner asked for export from the iOS app - a
/// deliberate reversal of spec §4.1a's original web-only call (see
/// Export/ExportView.swift for the reasoning that survives the reversal).
/// This client generates nothing and derives no dates: it asks for a
/// period, polls the job the server runs, and hands the person the file
/// (spec §4.1) - exactly as the web client already does.

/// One way to name an export period, mirrored from the server's
/// `exportRequestSchema` union: the caller's own fiscal year (the server
/// derives the actual dates from account settings at request time) or an
/// explicit range. The zip's contents, the byte budget, and the fiscal
/// math are all the server's (spec §8); this is only ever what the person
/// picked on screen.
enum ExportRequest: Encodable, Equatable {
    case fiscalYear(endingIn: Int)
    case range(periodStart: String, periodEnd: String)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .fiscalYear(let endingIn):
            try container.encode(endingIn, forKey: .fiscalYearEndingIn)
        case .range(let periodStart, let periodEnd):
            try container.encode(periodStart, forKey: .periodStart)
            try container.encode(periodEnd, forKey: .periodEnd)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case fiscalYearEndingIn, periodStart, periodEnd
    }
}

/// The six states a job can report, exactly as the server's `jobResponse`
/// sends them. `expired` and `stale` are computed server-side, never
/// stored, but arrive as ordinary strings alongside the four stored
/// states - this client does not need to know which is which, only that
/// both mean "re-run", not "wait".
enum ExportJobStatus: String, Decodable, Equatable {
    case queued
    case running
    case complete
    case failed
    case expired
    case stale

    /// Whether a client should stop polling. A job past this point will
    /// never change again on its own - `expired` and `stale` included,
    /// which is the entire point of computing them: nothing here would
    /// ever tell a client still waiting on a lost or crashed job to stop
    /// otherwise, since there is no sweeper process.
    var isTerminal: Bool {
        switch self {
        case .queued, .running: return false
        case .complete, .failed, .expired, .stale: return true
        }
    }
}

/// POST /api/export, GET /api/export, GET /api/export/:id all answer with
/// this shape. `periodStart`/`periodEnd` are always present - per the
/// server's own comment, that is what makes an `expired` or `stale` job
/// re-runnable from the response alone, with no other state needed.
struct ExportJob: Decodable, Equatable, Identifiable {
    let id: UUID
    let status: ExportJobStatus
    let periodStart: String
    let periodEnd: String
    /// The recorded failure, written to be read by a person (an
    /// oversized-export message that says to export a shorter period, a
    /// missing-image message that names the receipt id) - shown verbatim,
    /// never replaced with this client's own wording. Present only when
    /// `status == .failed`.
    let error: String?
    let createdAt: Date
    let completedAt: Date?
    /// A presigned, short-lived download URL - present only while
    /// `status == .complete` and the 30-day window has not lapsed (an
    /// unexpired job past that window reports `.expired` instead, with
    /// this nil).
    let downloadUrl: URL?
}
