import XCTest
@testable import Kept

/// The two things 2026-10-31 added to what a money box accepts, and the
/// line it had to keep. `ConfirmReceiptModelTests` holds the older rules.
final class MoneyInputSeparatorAndBoundTests: XCTestCase {
    // MARK: - A comma as the decimal separator

    /// How French Canadian writes money. Rejecting it left the box
    /// unreadable and the cents unsaved.
    func testACommaIsADecimalSeparatorWhereItCanOnlyBeOne() {
        XCTAssertEqual(MoneyInput.parse("12,50"), .cents(1250))
        XCTAssertEqual(MoneyInput.parse("12,5"), .cents(1250))
        XCTAssertEqual(MoneyInput.parse("0,05"), .cents(5))
        XCTAssertEqual(MoneyInput.parse("1234,56"), .cents(123456))
        XCTAssertEqual(MoneyInput.parse("-45,20"), .cents(-4520))
        XCTAssertEqual(MoneyInput.parse("$12,50"), .cents(1250))
        XCTAssertEqual(MoneyInput.parse(" 12,50 "), .cents(1250))
    }

    /// Three digits after a comma is thousands, as it has always been: a
    /// comma cannot introduce three decimals of money.
    func testACommaBeforeThreeDigitsIsStillThousands() {
        XCTAssertEqual(MoneyInput.parse("1,234"), .cents(123400))
        XCTAssertEqual(MoneyInput.parse("12,345"), .cents(1234500))
        XCTAssertEqual(MoneyInput.parse("1,234,567"), .cents(123456700))
        XCTAssertEqual(MoneyInput.parse("$1,234.56"), .cents(123456))
        XCTAssertEqual(MoneyInput.parse("1,234.50"), .cents(123450))
    }

    /// Two separators that disagree, or a shape neither reading fits, are
    /// not guessed at.
    func testAmbiguousSeparatorsAreRefused() {
        XCTAssertEqual(MoneyInput.parse("1.234,50"), .invalid)
        XCTAssertEqual(MoneyInput.parse("1,234,56"), .invalid)
        XCTAssertEqual(MoneyInput.parse("12,50.00"), .invalid)
        XCTAssertEqual(MoneyInput.parse("1,2,3"), .invalid)
        XCTAssertEqual(MoneyInput.parse(",50"), .invalid)
        XCTAssertEqual(MoneyInput.parse("12,5678"), .invalid)
    }

    /// Mid-keystroke, the same state `12.` is, and the tracking rule's
    /// suspension covers it for the same reason.
    func testATrailingCommaIsMidKeystroke() {
        XCTAssertEqual(MoneyInput.parse("12,"), .invalid)
        XCTAssertEqual(MoneyInput.parse("12."), .invalid)
    }

    // MARK: - The server's bound

    func testTheBoundIsTheServersInt4() {
        XCTAssertEqual(MoneyInput.parse("21474836.47"), .cents(2_147_483_647))
        XCTAssertEqual(MoneyInput.parse("21474836.48"), .outOfRange)
        XCTAssertEqual(MoneyInput.parse("-21474836.48"), .cents(-2_147_483_648))
        XCTAssertEqual(MoneyInput.parse("-21474836.49"), .outOfRange)
    }

    func testTheOutOfRangeReadingIsTheSameWhicheverSeparator() {
        XCTAssertEqual(MoneyInput.parse("99999999.00"), .outOfRange)
        XCTAssertEqual(MoneyInput.parse("99999999,00"), .outOfRange)
        XCTAssertEqual(MoneyInput.parse("99,999,999.00"), .outOfRange)
    }

    func testBothUnusableStatesReadAsUnusable() {
        XCTAssertTrue(MoneyInput.invalid.isUnusable)
        XCTAssertTrue(MoneyInput.outOfRange.isUnusable)
        XCTAssertFalse(MoneyInput.empty.isUnusable)
        XCTAssertFalse(MoneyInput.cents(0).isUnusable)
    }

    // MARK: - The sign toggle

    func testTogglingTheSign() {
        XCTAssertEqual(MoneyInput.togglingSign(of: "45.20"), "-45.20")
        XCTAssertEqual(MoneyInput.togglingSign(of: "-45.20"), "45.20")
        XCTAssertEqual(MoneyInput.togglingSign(of: "$45.20"), "-$45.20")
        XCTAssertEqual(MoneyInput.togglingSign(of: "12,50"), "-12,50")
        XCTAssertEqual(MoneyInput.togglingSign(of: ""), "-")
        XCTAssertEqual(MoneyInput.togglingSign(of: "-"), "")
    }

    /// Every result has to be something the parser reads as the same
    /// amount, negated - the toggle is no use otherwise.
    func testWhatTheToggleProducesParses() {
        for text in ["45.20", "12,50", "$45.20", "1,234.56"] {
            guard case .cents(let positive) = MoneyInput.parse(text) else {
                return XCTFail("\(text) did not parse")
            }
            XCTAssertEqual(MoneyInput.parse(MoneyInput.togglingSign(of: text)), .cents(-positive), text)
        }
    }
}

/// `DocumentScannerView` itself cannot run here (the simulator has no
/// camera), so the rule that keeps a scan's good pages is tested alone.
final class ScannedPagesTests: XCTestCase {
    func testOneBadPageKeepsTheOthers() {
        let result = ScannedPages.encode(pageCount: 3) { index in
            index == 1 ? nil : Data([UInt8(index)])
        }

        XCTAssertEqual(result.pages, [Data([0]), Data([2])], "in scan order, none lost")
        XCTAssertEqual(result.failedPageNumbers, [2])
        XCTAssertEqual(result.failureNote, "Page 2 of 3 could not be saved. Scan it again.")
    }

    func testAnEntirelyGoodScanSaysNothing() {
        let result = ScannedPages.encode(pageCount: 2) { _ in Data([1]) }
        XCTAssertEqual(result.pages.count, 2)
        XCTAssertNil(result.failureNote)
    }

    func testSeveralBadPagesAreNamed() {
        let result = ScannedPages.encode(pageCount: 4) { index in
            index == 0 ? Data([1]) : nil
        }
        XCTAssertEqual(result.failureNote, "Pages 2, 3, 4 of 4 could not be saved. Scan them again.")
    }

    func testEveryPageFailingStillStatesIt() {
        let result = ScannedPages.encode(pageCount: 1) { _ in nil }
        XCTAssertTrue(result.pages.isEmpty)
        XCTAssertEqual(result.failureNote, "Page 1 of 1 could not be saved. Scan it again.")
    }

    /// Each page is released before the next is decoded. The object below
    /// is autoreleased inside the encode, so if it survives the pool it
    /// would still be alive when the next page starts.
    func testEachPageIsDrainedBeforeTheNext() {
        weak var previous: NSObject?
        var liveAtNextPage: [Bool] = []

        _ = ScannedPages.encode(pageCount: 3) { _ in
            liveAtNextPage.append(previous != nil)
            let image = NSObject()
            previous = image
            _ = Unmanaged.passUnretained(image).retain().autorelease()
            return Data([1])
        }

        XCTAssertEqual(liveAtNextPage, [false, false, false])
    }
}
