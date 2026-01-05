import SwiftUI
import MapKit

struct ContentView: View {
    @StateObject private var locationManager = LocationManager()
    @StateObject private var curbVM = CurbViewModel()
    
    @State private var searchText: String = ""
    @State private var searchStatus: String? = nil
    
    @State private var isShowingSignScan = false
    @State private var lastScannedSignText: String = ""
    
    @State private var selected: CurbSegment? = nil
    @State private var position: MapCameraPosition = .userLocation(fallback: .automatic)

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {

                Map(position: $position) {
                    UserAnnotation()

                    ForEach(curbVM.segments) { segment in
                        MapPolyline(coordinates: segment.coordinates)
                            .stroke(segment.status.color, lineWidth: selected?.id == segment.id ? 10 : 7)
                            .mapOverlayLevel(level: .aboveRoads)

                        Annotation("", coordinate: midpoint(of: segment.coordinates)) {
                            Button {
                                selected = segment
                            } label: {
                                ZStack {
                                    Circle()
                                        .fill(.ultraThinMaterial)
                                        .frame(width: 28, height: 28)

                                    Circle()
                                        .fill(segment.status.color)
                                        .frame(width: 10, height: 10)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Show parking details for \(segment.name)")
                        }
                    }
                }
                .mapStyle(.standard(elevation: .realistic))
                .mapControls {
                    MapUserLocationButton()
                    MapCompass()
                    MapScaleView()
                }
                .ignoresSafeArea()
                .onAppear {
                    locationManager.start()
                }
                .onChange(of: locationManager.location) { _, newLoc in
                    guard let newLoc else { return }
                    curbVM.refresh(near: newLoc.coordinate)
                }
                // ✅ ADD THIS OVERLAY
                .overlay(alignment: .topTrailing) {
                    if let s = selected {
                        ParkingPopup(segment: s) {
                            selected = nil
                        }
                        .padding()
                    }
                }

                bottomPanel
            }
            .navigationTitle("ParkNYC Prototype")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $isShowingSignScan) {
                SignScanSheet(scannedText: $lastScannedSignText)
            }

        }
    }
    
    
    private func searchDestination() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }

        searchStatus = "Searching…"

        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query

        // Bias search to NYC area so results are sane.
        let nycCenter = CLLocationCoordinate2D(latitude: 40.7580, longitude: -73.9855)
        request.region = MKCoordinateRegion(
            center: nycCenter,
            span: MKCoordinateSpan(latitudeDelta: 0.35, longitudeDelta: 0.35)
        )

        MKLocalSearch(request: request).start { response, error in
            DispatchQueue.main.async {
                if let error = error {
                    searchStatus = "Search failed: \(error.localizedDescription)"
                    return
                }
                guard let item = response?.mapItems.first else {
                    searchStatus = "No results found."
                    return
                }

                let coord = item.placemark.coordinate
                let region = MKCoordinateRegion(
                    center: coord,
                    span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
                )

                position = .region(region)
                curbVM.refresh(near: coord)
                searchStatus = nil
            }
        }
    }


    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Nearby curb guidance (mock)")
                    .font(.headline)
                Spacer()
                if let t = curbVM.lastUpdated?.shortTime() {
                    Text("Updated \(t)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                TextField("Search destination (e.g., 350 5th Ave)", text: $searchText)
                    .textFieldStyle(.roundedBorder)

                Button("Search") {
                    searchDestination()
                }
                .buttonStyle(.borderedProminent)
            }
            if let msg = searchStatus {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            
            Button("Jump to Times Square") {
                let nyc = CLLocationCoordinate2D(latitude: 40.7580, longitude: -73.9855)
                position = .region(MKCoordinateRegion(center: nyc,
                                                      span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)))
            }
            .buttonStyle(.bordered)
            
            Button("Scan a Parking Sign") {
                isShowingSignScan = true
            }
            .buttonStyle(.borderedProminent)


            if locationManager.authorizationStatus == .denied || locationManager.authorizationStatus == .restricted {
                Text("Location access is off. Enable it in Settings to show nearby blocks.")
                    .font(.subheadline)
            } else if curbVM.segments.isEmpty {
                Text("Waiting for location… (Simulator: Features → Location → Apple)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(curbVM.segments) { s in
                            Button {
                                selected = s
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Circle()
                                        .fill(s.status.color)
                                        .frame(width: 10, height: 10)
                                        .padding(.top, 6)

                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(s.name).font(.subheadline).bold()
                                            Spacer()
                                            Text(s.status.title)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }

                                        Text(s.explanation)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)

                                        HStack(spacing: 12) {
                                            Text(s.isMeteredLikely ? "Meter likely" : "No meter flag")
                                                .font(.caption2)

                                            if let next = s.nextChange {
                                                Text("Next change: \(next.shortTime())")
                                                    .font(.caption2)
                                            }
                                        }
                                        .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)

                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
            if !lastScannedSignText.isEmpty {
                Text("Last scan:")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(lastScannedSignText)
                    .font(.footnote)
                    .lineLimit(4)
            }
        }
        .padding(14)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding()
    }
    
}
private struct ParkingPopup: View {
    let segment: CurbSegment
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(segment.name)
                        .font(.subheadline)
                        .bold()

                    Text(segment.status.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .padding(8)
                }
                .buttonStyle(.plain)
                .background(.thinMaterial)
                .clipShape(Circle())
            }

            Divider()

            // Times (simple first pass)
            VStack(alignment: .leading, spacing: 6) {
                Text("Times")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if segment.status == .legalNow {
                    if let next = segment.nextChange {
                        Text("OK now • Next restriction: \(next.shortTime())")
                            .font(.callout)
                    } else {
                        Text("OK now")
                            .font(.callout)
                    }
                } else if segment.status == .illegalNow {
                    if let next = segment.nextChange {
                        Text("Not legal now • Possible change: \(next.shortTime())")
                            .font(.callout)
                    } else {
                        Text("Not legal now")
                            .font(.callout)
                    }
                } else {
                    Text("Rules unclear • Confirm posted signs")
                        .font(.callout)
                }
            }

            // Fees (placeholder until real meter-rate data)
            VStack(alignment: .leading, spacing: 6) {
                Text("Fees")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if segment.isMeteredLikely {
                    if let hours = segment.paidHoursText {
                        Text("Paid hours: \(hours)")
                            .font(.callout)
                    } else {
                        Text("Paid hours: check meter/ParkNYC")
                            .font(.callout)
                    }

                    if let rate = segment.rateText {
                        Text("Rate: \(rate)")
                            .font(.callout)
                    } else {
                        Text("Rate: check meter/ParkNYC")
                            .font(.callout)
                    }
                } else {
                    Text("No meter flag • Still confirm signage")
                        .font(.callout)
                }
            }



            Text(segment.explanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Text("Always obey posted signs.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(width: 300)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(radius: 8)
    }
}
