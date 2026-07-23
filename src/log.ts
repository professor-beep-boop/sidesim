type Sink = (line: string) => void;

let sink: Sink | undefined;

/** The extension wires this to an OutputChannel; tests/CLIs can leave it unset. */
export function setLogSink(s: Sink | undefined): void {
	sink = s;
}

export function log(message: string): void {
	sink?.(`[${new Date().toISOString()}] ${message}`);
}
