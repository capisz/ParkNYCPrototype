import Foundation
import Combine
import CoreLocation

@MainActor
final class CurbViewModel: ObservableObject {
    @Published var segments: [CurbSegment] = []
    @Published var lastUpdated: Date?

    private var allSegments: [CurbSegment] = []
    private let radiusMeters: Double = 900 // ~0.55 miles

    func refresh(near coordinate: CLLocationCoordinate2D) {
        // Load once
        if allSegments.isEmpty {
            allSegments = NYCSampleLoader.load()
        }

        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        segments = allSegments.filter { seg in
            let mid = midpoint(of: seg.coordinates)
            let midLoc = CLLocation(latitude: mid.latitude, longitude: mid.longitude)
            return center.distance(from: midLoc) <= radiusMeters
        }

        lastUpdated = Date()
    }

    func loadAll() {
        allSegments = NYCSampleLoader.load()
        segments = allSegments
        lastUpdated = Date()
    }
}

func midpoint(of coords: [CLLocationCoordinate2D]) -> CLLocationCoordinate2D {
    guard let first = coords.first, let last = coords.last else {
        return CLLocationCoordinate2D(latitude: 0, longitude: 0)
    }
    return CLLocationCoordinate2D(
        latitude: (first.latitude + last.latitude) / 2,
        longitude: (first.longitude + last.longitude) / 2
    )
}
