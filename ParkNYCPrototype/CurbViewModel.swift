import Foundation
import Combine
import CoreLocation
import MapKit

@MainActor
final class CurbViewModel: ObservableObject {
    @Published var segments: [CurbSegment] = []
    @Published var lastUpdated: Date?
    @Published var sourceLabel: String = "Pidge backend (live)"

    private let backendService = BackendParkingService()
    private let openDataFallbackService = NYCParkingOpenDataService()
    private let defaultRadiusMeters = 550
    private let minimumRadiusMeters = 180
    private let maximumRadiusMeters = 1200
    private let backendAugmentThreshold = 20
    private let minimumRefreshDistanceMeters: Double = 120
    private let minimumRefreshInterval: TimeInterval = 8
    private var refreshTask: Task<Void, Never>?
    private var lastRefreshRegion: MKCoordinateRegion?
    private var lastRefreshDate: Date?

    func refresh(near coordinate: CLLocationCoordinate2D, force: Bool = false) {
        refresh(near: coordinate, radiusMeters: defaultRadiusMeters, force: force)
    }

    func refresh(near coordinate: CLLocationCoordinate2D, radiusMeters: Int, force: Bool = false) {
        guard CLLocationCoordinate2DIsValid(coordinate) else { return }
        let clampedRadius = max(minimumRadiusMeters, min(maximumRadiusMeters, radiusMeters))
        let region = regionAround(coordinate: coordinate, radiusMeters: Double(clampedRadius))
        refresh(
            center: coordinate,
            radiusMeters: clampedRadius,
            regionForThrottling: region,
            force: force
        )
    }

    func refresh(in region: MKCoordinateRegion, force: Bool = false) {
        guard CLLocationCoordinate2DIsValid(region.center) else { return }
        let radius = inferredVisibleRadiusMeters(for: region)
        refresh(
            center: region.center,
            radiusMeters: radius,
            regionForThrottling: region,
            force: force
        )
    }

    private func refresh(
        center: CLLocationCoordinate2D,
        radiusMeters: Int,
        regionForThrottling: MKCoordinateRegion,
        force: Bool
    ) {
        if !force && shouldSkipRefresh(for: regionForThrottling) {
            return
        }

        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            do {
                let fetched = try await backendService.fetchSegments(
                    near: center,
                    radiusMeters: radiusMeters
                )
                guard !Task.isCancelled else { return }

                if fetched.isEmpty {
                    let fallback = try await fetchOpenDataSegments(
                        near: center,
                        radiusMeters: radiusMeters
                    )
                    guard !Task.isCancelled else { return }

                    segments = fallback
                    sourceLabel = fallback.isEmpty ? "Pidge backend (no nearby rows)" : "NYC Open Data fallback (live)"
                } else if fetched.count < backendAugmentThreshold {
                    var merged = fetched
                    var seen = Set(fetched.map(segmentSignature))

                    do {
                        let fallback = try await fetchOpenDataSegments(
                            near: center,
                            radiusMeters: radiusMeters
                        )
                        guard !Task.isCancelled else { return }

                        for segment in fallback {
                            let signature = segmentSignature(segment)
                            if seen.insert(signature).inserted {
                                merged.append(segment)
                            }
                        }
                        segments = merged
                        sourceLabel = merged.count > fetched.count ? "Pidge backend + Open Data augment" : "Pidge backend (live)"
                    } catch {
                        segments = fetched
                        sourceLabel = "Pidge backend (live)"
                    }
                } else {
                    segments = fetched
                    sourceLabel = "Pidge backend (live)"
                }
            } catch is CancellationError {
                return
            } catch {
                let backendError = error
                do {
                    let fetched = try await fetchOpenDataSegments(
                        near: center,
                        radiusMeters: radiusMeters
                    )
                    guard !Task.isCancelled else { return }

                    segments = fetched
                    sourceLabel = fetched.isEmpty ? "NYC Open Data fallback (no nearby rows)" : "NYC Open Data fallback (live)"
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    print("Backend fetch failed: \(backendError.localizedDescription)")
                    print("Live fallback fetch failed: \(error.localizedDescription)")
                    segments = fallbackSegments(near: center, radiusMeters: radiusMeters)
                    sourceLabel = "Sample fallback (network issue)"
                }
            }

            lastRefreshRegion = regionForThrottling
            lastRefreshDate = Date()
            lastUpdated = Date()
        }
    }

    func loadAll() {
        let sample = NYCSampleLoader.load()
        segments = sample
        sourceLabel = "Sample fallback"
        lastUpdated = Date()
    }

    private func shouldSkipRefresh(for region: MKCoordinateRegion) -> Bool {
        guard let lastRefreshRegion, let lastRefreshDate else {
            return false
        }

        let sinceLastRefresh = Date().timeIntervalSince(lastRefreshDate)
        if sinceLastRefresh > minimumRefreshInterval {
            return false
        }

        let previous = CLLocation(latitude: lastRefreshRegion.center.latitude, longitude: lastRefreshRegion.center.longitude)
        let current = CLLocation(latitude: region.center.latitude, longitude: region.center.longitude)
        let movedMeters = previous.distance(from: current)
        if movedMeters >= minimumRefreshDistanceMeters {
            return false
        }

        let latZoomShift = spanShift(
            oldValue: lastRefreshRegion.span.latitudeDelta,
            newValue: region.span.latitudeDelta
        )
        let lonZoomShift = spanShift(
            oldValue: lastRefreshRegion.span.longitudeDelta,
            newValue: region.span.longitudeDelta
        )

        return latZoomShift < 0.22 && lonZoomShift < 0.22
    }

    private func fetchOpenDataSegments(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int
    ) async throws -> [CurbSegment] {
        let radius = max(minimumRadiusMeters, min(maximumRadiusMeters, radiusMeters))
        let limit = radius >= 900 ? 120 : 80
        return try await openDataFallbackService.fetchSegments(
            near: coordinate,
            radiusMeters: radius,
            limit: limit
        )
    }

    private func inferredVisibleRadiusMeters(for region: MKCoordinateRegion) -> Int {
        let latMeters = max(region.span.latitudeDelta, 0.001) * 111_320
        let latRadians = region.center.latitude * .pi / 180
        let lonScale = max(cos(latRadians), 0.2)
        let lonMeters = max(region.span.longitudeDelta, 0.001) * 111_320 * lonScale
        let visibleCircleRadius = min(latMeters, lonMeters) / 2
        let padded = visibleCircleRadius + 40
        let clamped = max(Double(minimumRadiusMeters), min(Double(maximumRadiusMeters), padded))
        return Int(clamped.rounded(.up))
    }

    private func regionAround(coordinate: CLLocationCoordinate2D, radiusMeters: Double) -> MKCoordinateRegion {
        let latDelta = max(radiusMeters / 55_660, 0.01)
        let lonScale = max(cos(coordinate.latitude * .pi / 180), 0.2)
        let lonDelta = max(radiusMeters / (55_660 * lonScale), 0.01)

        return MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: latDelta, longitudeDelta: lonDelta)
        )
    }

    private func spanShift(oldValue: Double, newValue: Double) -> Double {
        guard oldValue > 0 else { return 1 }
        return abs(newValue - oldValue) / oldValue
    }

    private func segmentSignature(_ segment: CurbSegment) -> String {
        let first = segment.coordinates.first ?? midpoint(of: segment.coordinates)
        let last = segment.coordinates.last ?? midpoint(of: segment.coordinates)
        let fLat = roundedCoord(first.latitude)
        let fLon = roundedCoord(first.longitude)
        let lLat = roundedCoord(last.latitude)
        let lLon = roundedCoord(last.longitude)
        return "\(segment.name.uppercased())|\(fLat)|\(fLon)|\(lLat)|\(lLon)"
    }

    private func roundedCoord(_ value: Double) -> String {
        String(format: "%.5f", value)
    }

    private func fallbackSegments(near coordinate: CLLocationCoordinate2D, radiusMeters: Int) -> [CurbSegment] {
        let all = NYCSampleLoader.load()
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        let nearby = all.filter { segment in
            let mid = midpoint(of: segment.coordinates)
            let loc = CLLocation(latitude: mid.latitude, longitude: mid.longitude)
            return center.distance(from: loc) <= Double(radiusMeters)
        }

        return nearby.isEmpty ? all : nearby
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
