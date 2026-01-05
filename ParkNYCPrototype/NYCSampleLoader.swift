import Foundation
import CoreLocation

struct NYCSampleFile: Decodable {
    let segments: [NYCSampleSegment]
}

struct NYCSampleSegment: Decodable {
    struct Point: Decodable {
        let lat: Double
        let lng: Double
    }

    let name: String
    let status: String
    let explanation: String
    let isMeteredLikely: Bool
    let paidHoursText: String?
    let rateText: String?
    let coordinates: [Point]
}

enum NYCSampleLoader {
    static func load() -> [CurbSegment] {
        guard let url = Bundle.main.url(forResource: "nyc_sample", withExtension: "json") else {
            print("nyc_sample.json not found in bundle")
            return []
        }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(NYCSampleFile.self, from: data)

            return decoded.segments.map { s in
                let coords = s.coordinates.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }

                let status: ParkingStatus
                switch s.status.lowercased() {
                case "legalnow": status = .legalNow
                case "caution": status = .caution
                case "illegalnow": status = .illegalNow
                default: status = .unknown
                }

                return CurbSegment(
                    name: s.name,
                    coordinates: coords,
                    status: status,
                    explanation: s.explanation,
                    isMeteredLikely: s.isMeteredLikely,
                    nextChange: nil,
                    paidHoursText: s.paidHoursText,
                    rateText: s.rateText
                )
            }
        } catch {
            print("Failed to load nyc_sample.json:", error)
            return []
        }
    }
}
