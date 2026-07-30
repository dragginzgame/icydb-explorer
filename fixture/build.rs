use fixture_schema as _;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    icydb::build::build_configured_canister!((), "fixture_schema::Canister", "fixture");

    Ok(())
}
