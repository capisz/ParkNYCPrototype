import SwiftUI
import VisionKit

struct SignScanSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var scannedText: String

    @State private var isSupported = false
    @State private var isAvailable = false
    @State private var lastTapText: String = ""

    var body: some View {
        NavigationStack {
            Group {
                if !isSupported {
                    Text("Text scanning isn’t supported on this device.")
                        .padding()
                } else if !isAvailable {
                    Text("Scanner is currently unavailable.")
                        .padding()
                } else {
                    ZStack(alignment: .bottom) {
                        DataScannerRepresentable { text in
                            lastTapText = text
                        }
                        .ignoresSafeArea()

                        VStack(alignment: .leading, spacing: 10) {
                            Text("Point at a sign and tap the highlighted text.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)

                            if !lastTapText.isEmpty {
                                Text(lastTapText)
                                    .font(.footnote)
                                    .lineLimit(4)
                                    .padding(10)
                                    .background(.thinMaterial)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                            } else {
                                Text("No text selected yet.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }

                            HStack {
                                Button("Cancel") { dismiss() }
                                    .buttonStyle(.bordered)

                                Spacer()

                                Button("Use Selected Text") {
                                    scannedText = lastTapText
                                    dismiss()
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(lastTapText.isEmpty)
                            }
                        }
                        .padding()
                        .background(.ultraThinMaterial)
                    }
                }
            }
            .navigationTitle("Scan Parking Sign")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                isSupported = DataScannerViewController.isSupported
                isAvailable = DataScannerViewController.isAvailable
            }
        }
    }
}
