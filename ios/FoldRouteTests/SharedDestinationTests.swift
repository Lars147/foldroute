import Foundation
import XCTest
@testable import FoldRoute

final class SharedDestinationTests: XCTestCase {
    struct Fixture: Decodable {
        let name: String
        let payload: Fields
        let expected: SharedDestination
        struct Fields: Decodable {
            var title: String?
            var text: String?
            var url: String?
        }
    }

    func testSharedParserParity() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "shared-destinations", withExtension: "json"))
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        for fixture in fixtures {
            let payload = SharePayload(title: fixture.payload.title ?? "", text: fixture.payload.text ?? "", url: fixture.payload.url ?? "")
            XCTAssertEqual(SharedDestination.parse(payload), fixture.expected, fixture.name)
        }
    }

    func testPendingImportReplacesOldAndCannotConsumeNewerShare() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SharedDestinationStore(directory: directory)
        XCTAssertNil(try store.read())
        let first = PendingSharedDestination(payload: SharePayload(text: "München Hbf"))
        let second = PendingSharedDestination(payload: SharePayload(text: "Daglfing"))
        try store.save(first)
        XCTAssertEqual(try store.read(), first)
        try store.save(second)
        try store.remove(id: first.id)
        XCTAssertEqual(try store.read(), second)
        try store.remove(id: second.id)
        XCTAssertNil(try store.read())
    }

    func testClearRemovesPendingImportAndUnknownVersionFails() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SharedDestinationStore(directory: directory)
        var item = PendingSharedDestination(payload: SharePayload(text: "München Hbf"))
        item.version = 99
        try store.save(item)
        XCTAssertThrowsError(try store.read())
        try store.remove()
        XCTAssertNil(try store.read())
    }
}
