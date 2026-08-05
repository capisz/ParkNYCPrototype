import Foundation
import Combine
import CoreLocation
import MapKit

@MainActor
final class CurbViewModel: ObservableObject {
    @Published var segments: [CurbSegment] = []
    @Published var lastUpdated: Date?
    @Published var sourceLabel: String = "NYC Parking Planner advisory data"
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var isShowingStaleData = false

    private let backendService = BackendParkingService()
    private let defaultRadiusMeters = 550
    private let minimumRadiusMeters = 180
    private let maximumRadiusMeters = 1200
    private let maximumStreetDataShortEdgeMeters: Double = 2600
    private let minimumRefreshDistanceMeters: Double = 120
    private let minimumRefreshInterval: TimeInterval = 8
    private var refreshTask: Task<Void, Never>?
    private var lastRefreshRegion: MKCoordinateRegion?
    private var lastRefreshDate: Date?
    private var evaluationStart = Date()
    private var evaluationEnd = Date().addingTimeInterval(60 * 60)

    func setEvaluationInterval(start: Date, end: Date) {
        evaluationStart = start
        evaluationEnd = end
        lastRefreshDate = nil
    }

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
        if visibleShortEdgeMeters(for: region) > maximumStreetDataShortEdgeMeters {
            refreshTask?.cancel()
            refreshTask = nil
            segments = []
            sourceLabel = "Zoom in to street level"
            errorMessage = nil
            isLoading = false
            isShowingStaleData = false
            return
        }
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
            isLoading = true
            errorMessage = nil
            do {
                let fetched = try await backendService.fetchSegments(
                    near: center,
                    radiusMeters: radiusMeters,
                    start: evaluationStart,
                    end: evaluationEnd
                )
                guard !Task.isCancelled else { return }

                segments = fetched
                isShowingStaleData = false
                sourceLabel = fetched.isEmpty ? "No curb rows in the visible area" : "NYC advisory curb classifications"
                lastUpdated = Date()
            } catch is CancellationError {
                isLoading = false
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = "Curb data unavailable: \(error.localizedDescription)"
                isShowingStaleData = !segments.isEmpty
                sourceLabel = segments.isEmpty ? "Curb data unavailable" : "Previously loaded curb data • refresh failed"
            }

            lastRefreshRegion = regionForThrottling
            lastRefreshDate = Date()
            isLoading = false
        }
    }

    func loadAll() {
        let sample = NYCSampleLoader.load()
        segments = sample
        sourceLabel = "Developer sample preview"
        errorMessage = nil
        isShowingStaleData = false
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

    private func inferredVisibleRadiusMeters(for region: MKCoordinateRegion) -> Int {
        let visibleCircleRadius = visibleShortEdgeMeters(for: region) / 2
        let padded = visibleCircleRadius + 40
        let clamped = max(Double(minimumRadiusMeters), min(Double(maximumRadiusMeters), padded))
        return Int(clamped.rounded(.up))
    }

    private func visibleShortEdgeMeters(for region: MKCoordinateRegion) -> Double {
        let latMeters = max(region.span.latitudeDelta, 0.001) * 111_320
        let latRadians = region.center.latitude * .pi / 180
        let lonScale = max(cos(latRadians), 0.2)
        let lonMeters = max(region.span.longitudeDelta, 0.001) * 111_320 * lonScale
        return min(latMeters, lonMeters)
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
