// Dumps Vision's real text observations for a receipt image, as
// RecognizedLine literals ready to paste into a parser fixture.
//
//   swift ios/Tools/vision-dump.swift path/to/receipt.jpg
//
// This exists because of the wave-4 lesson: a fixture with invented
// geometry verified the author's model of Vision rather than Vision, and
// let a device regression sail through a test that did assert the field.
// Fixtures for real receipts use this dump verbatim. The request settings
// and the bottom-left-origin flip match VisionReceiptTextRecognizer
// exactly; macOS and iOS Vision may still measure a few percent apart,
// which is the jitter the parser's band heuristics are built to survive.
//
// Not part of any build target - a standalone macOS script, run with the
// `swift` CLI. (Wave-5 device step 1; committed so the next wave's dump
// is a command, not an archaeology project.)

import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: swift vision-dump.swift <image-file>\n".utf8))
    exit(64)
}

do {
    let imageData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(data: imageData).perform([request])

    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        let text = candidate.string
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        print(String(
            format: "RecognizedLine(text: \"%@\", verticalCenter: %.4f, height: %.4f, horizontalCenter: %.4f),",
            text,
            1.0 - box.midY, // Vision's origin is bottom-left; the parser reads top-down
            box.height,
            box.midX
        ))
    }
} catch {
    FileHandle.standardError.write(Data("vision-dump failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
