/**
 * Common helper functions for the Remote Control application.
 */



/**
 * Format bits per second to a human-readable bitrate string.
 * @param {number} bitsPerSecond - The bitrate in bits per second.
 * @returns {string} The formatted bitrate.
 */
export function formatBitrate(bitsPerSecond) {
	if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
		return "0 kbps";
	}
	if (bitsPerSecond >= 1000 * 1000) {
		return `${(bitsPerSecond / (1000 * 1000)).toFixed(2)} Mbps`;
	}
	return `${(bitsPerSecond / 1000).toFixed(1)} kbps`;
}
