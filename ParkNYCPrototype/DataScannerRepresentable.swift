import SwiftUI
import VisionKit

struct DataScannerRepresentable: UIViewControllerRepresentable {
    let onTapText: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.text()],
            qualityLevel: .balanced,
            recognizesMultipleItems: true,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {
        if !uiViewController.isScanning {
            do { try uiViewController.startScanning() }
            catch { print("startScanning failed:", error.localizedDescription) }
        }
    }

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onTapText: onTapText)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onTapText: (String) -> Void
        init(onTapText: @escaping (String) -> Void) { self.onTapText = onTapText }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            switch item {
            case .text(let t):
                onTapText(t.transcript)
            default:
                break
            }
        }
    }
}
