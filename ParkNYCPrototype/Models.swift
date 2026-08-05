
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
        case .legalNow: return "Likely free · verify signs"
        case .caution: return "Paid parking"
        case .illegalNow: return "Cannot park"
        case .unknown: return "Unknown — check signs"
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
    let licenseNumber: String?
    let licenseStatus: String?
    let licenseExpiresAt: String?

    init(
        name: String,
        address: String,
        coordinate: CLLocationCoordinate2D,
        distanceMeters: CLLocationDistance,
        phoneNumber: String?,
        licenseNumber: String? = nil,
        licenseStatus: String? = nil,
        licenseExpiresAt: String? = nil
    ) {
        let latKey = String(format: "%.5f", coordinate.latitude)
        let lonKey = String(format: "%.5f", coordinate.longitude)
        self.id = "\(name.uppercased())|\(latKey)|\(lonKey)"
        self.name = name
        self.address = address
        self.coordinate = coordinate
        self.distanceMeters = distanceMeters
        self.phoneNumber = phoneNumber
        self.licenseNumber = licenseNumber
        self.licenseStatus = licenseStatus
        self.licenseExpiresAt = licenseExpiresAt
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

struct ParkingAvailability: Decodable, Equatable {
    let cannotPark: Int
    let paid: Int
    let free: Int
    let unknown: Int
}

struct ParkingRecommendationPreferences: Equatable {
    let allowPaid: Bool
    let allowGarages: Bool
    let maxWalkMinutes: Int
    let allowTransit: Bool
    let accessibleOnly: Bool
}

struct ParkingRecommendationTransit: Decodable, Equatable {
    let state: String
    let realtimeAsOf: String?
}

struct ParkingRecommendationFacility: Decodable, Equatable {
    let legalName: String?
    let dbaName: String?
    let licenseNumber: String?
    let licenseStatus: String?
    let licenseExpiresAt: String?
    let facilityDetails: String?
}

struct ParkingRecommendationWarning: Decodable, Equatable {
    let code: String
    let message: String
}

struct ParkingRecommendationInterval: Decodable, Equatable {
    let start: String
    let end: String
}

struct ParkingRecommendation: Identifiable, Decodable, Equatable {
    let id: String
    let kind: String
    let tier: String
    let status: String
    let title: String
    let subtitle: String
    let latitude: Double
    let longitude: Double
    let distanceMeters: Double
    let walkMinutes: Int
    let confidence: Double?
    let coverage: String
    let score: Double
    let ruleSummary: String
    let nextChange: String?
    let sourceVersion: String?
    let facility: ParkingRecommendationFacility?
    let transit: ParkingRecommendationTransit?
    let guidanceLevel: String?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    var statusColor: Color {
        switch tier {
        case "free": return .green
        case "paid": return .yellow
        case "park_and_ride": return Color(hexValue: "#225F9B")
        default: return Color(hexValue: "#61718F")
        }
    }

    var tierLabel: String {
        switch tier {
        case "free": return "Likely free · verify signs"
        case "paid": return guidanceLevel == "public_data_reference" ? "Paid lead · verify signs" : "Paid curb"
        case "facility": return "Licensed facility"
        case "park_and_ride": return "Park and ride"
        default: return tier.capitalized
        }
    }
}

struct ParkingRecommendationResponse: Decodable {
    let generatedAt: String
    let expiresAt: String
    let interval: ParkingRecommendationInterval
    let timezone: String
    let availability: ParkingAvailability
    let options: [ParkingRecommendation]
    let warnings: [ParkingRecommendationWarning]
    let disclaimer: String
}


extension Date {
    func shortTime() -> String {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: self)
    }
}

private extension Color {
    init(hexValue: String) {
        let raw = hexValue.replacingOccurrences(of: "#", with: "")
        var value: UInt64 = 0
        Scanner(string: raw).scanHexInt64(&value)
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
