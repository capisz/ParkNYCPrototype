
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
        case .legalNow: return "Free parking now"
        case .caution: return "Paid parking now"
        case .illegalNow: return "Do not park now"
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
    let confidence: Double
    let ruleSummary: String
    let sourceFreshness: String?
    let sourceName: String?

    init(name: String, coordinates: [CLLocationCoordinate2D], status: ParkingStatus,
         explanation: String, isMeteredLikely: Bool, nextChange: Date?,
         paidHoursText: String?, rateText: String?, confidence: Double = 0.25,
         ruleSummary: String? = nil, sourceFreshness: String? = nil, sourceName: String? = nil) {
        self.name = name
        self.coordinates = coordinates
        self.status = status
        self.explanation = explanation
        self.isMeteredLikely = isMeteredLikely
        self.nextChange = nextChange
        self.paidHoursText = paidHoursText
        self.rateText = rateText
        self.confidence = confidence
        self.ruleSummary = ruleSummary ?? explanation
        self.sourceFreshness = sourceFreshness
        self.sourceName = sourceName
    }
}

struct GarageOption: Identifiable {
    let id: String
    let name: String
    let address: String
    let coordinate: CLLocationCoordinate2D
    let distanceMeters: CLLocationDistance
    let phoneNumber: String?

    init(
        name: String,
        address: String,
        coordinate: CLLocationCoordinate2D,
        distanceMeters: CLLocationDistance,
        phoneNumber: String?
    ) {
        let latKey = String(format: "%.5f", coordinate.latitude)
        let lonKey = String(format: "%.5f", coordinate.longitude)
        self.id = "\(name.uppercased())|\(latKey)|\(lonKey)"
        self.name = name
        self.address = address
        self.coordinate = coordinate
        self.distanceMeters = distanceMeters
        self.phoneNumber = phoneNumber
    }

    var distanceText: String {
        let miles = distanceMeters / 1609.344
        if miles >= 0.2 {
            return String(format: "%.1f mi", miles)
        }
        let feet = distanceMeters * 3.28084
        return "\(Int(feet.rounded())) ft"
    }
}


extension Date {
    func shortTime() -> String {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: self)
    }
}
