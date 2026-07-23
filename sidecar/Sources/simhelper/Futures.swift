import Foundation
import FBControlCore

private let futureQueue = DispatchQueue(label: "simhelper.futures")

/// Block until an FBFuture resolves; throw on error or timeout.
@discardableResult
func waitFor<T>(_ future: FBFuture<T>, timeout: TimeInterval = 30) throws -> T? {
	let sem = DispatchSemaphore(value: 0)
	future.onQueue(futureQueue, notifyOfCompletion: { _ in sem.signal() })
	if sem.wait(timeout: .now() + timeout) == .timedOut {
		throw RequestError("timed out after \(Int(timeout))s waiting for \(future)")
	}
	if let error = future.error {
		throw error
	}
	return future.result as? T
}
