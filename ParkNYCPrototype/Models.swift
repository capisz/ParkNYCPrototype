
import Foundation
import SwiftUI
import CoreLocation

enum ParkingStatus: String {
    case legalNow
    case caution
    case illegalNow
    case unknown

    var title: String {
        switch self {
        case .legalNow: return "Legal now"
        case .caution: return "Caution"
        case .illegalNow: return "Not legal now"
        case .unknown: return "Unknown"
        }
    }

    var color: Color {
        switch self {
        case .legalNow: return .green
        case .caution: return .yellow
        case .illegalNow: return .red
        case .unknown: return .gray
        }
    }
}

struct CurbSegment: Identifiable {
    let id = UUID()
    let name: String
    let coordinates: [CLLocationCoordinate2D]

    let status: ParkingStatus
    let explanation: String

    let isMeteredLikely: Bool
    let nextChange: Date?

    // NEW (simple strings for now)
    let paidHoursText: String?
    let rateText: String?
}


extension Date {
    func shortTime() -> String {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: self)
    }
}
