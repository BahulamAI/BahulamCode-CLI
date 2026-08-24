/**
 * PRD-092 Slice G — Device pairing (stub).
 *
 * Full implementation pending: Supabase device registration,
 * cryptographic key exchange, QR code generation.
 */

export async function runPairCommand(args = []) {
  process.stderr.write('\x1b[33m! pair: not yet implemented (PRD-092 Slice G)\x1b[0m\n');
  process.stderr.write('  This command will pair a device for remote access.\n');
}
