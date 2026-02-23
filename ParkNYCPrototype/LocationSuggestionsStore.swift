import Foundation
import MapKit
import Combine

@MainActor
final class LocationSuggestionsStore: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {
    @Published private(set) var suggestions: [MKLocalSearchCompletion] = []

    private let completer = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 40.7580, longitude: -73.9855),
            span: MKCoordinateSpan(latitudeDelta: 0.35, longitudeDelta: 0.35)
        )
        completer.resultTypes = [.address, .pointOfInterest]
    }

    func update(query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            suggestions = []
            completer.queryFragment = ""
            return
        }

        completer.queryFragment = trimmed
    }

    func clear() {
        suggestions = []
        completer.queryFragment = ""
    }

    func formattedText(for suggestion: MKLocalSearchCompletion) -> String {
        let title = suggestion.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = suggestion.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if subtitle.isEmpty {
            return title
        }
        return "\(title), \(subtitle)"
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        Task { @MainActor in
            suggestions = completer.results
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: any Error) {
        Task { @MainActor in
            suggestions = []
        }
        print("Location suggestions failed:", error.localizedDescription)
    }
}
