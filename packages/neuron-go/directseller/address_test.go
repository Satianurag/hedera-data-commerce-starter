package directseller

import (
	"net/netip"
	"testing"
)

func TestPublicIPv4RejectsReservedRanges(t *testing.T) {
	for _, value := range []string{"0.0.0.0", "0.255.255.255", "10.0.0.1", "100.64.0.0", "100.127.255.255", "127.0.0.1", "169.254.0.0", "169.254.255.255", "172.16.0.1", "192.0.0.1", "192.0.2.255", "192.88.99.1", "192.168.0.1", "198.18.0.0", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255", "::ffff:8.8.8.8", "2001:4860:4860::8888"} {
		if PublicIPv4(netip.MustParseAddr(value)) {
			t.Errorf("reserved or non-IPv4 address accepted: %s", value)
		}
		if err := ValidateQUICAddress("/ip4/"+value+"/udp/4001/quic-v1", false); err == nil {
			t.Errorf("reserved target accepted: %s", value)
		}
	}
	for _, value := range []string{"1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.0", "198.17.255.255", "198.20.0.0"} {
		if !PublicIPv4(netip.MustParseAddr(value)) {
			t.Errorf("public address rejected: %s", value)
		}
	}
}

func TestQUICAddressRequiresCanonicalPortAndExactLoopback(t *testing.T) {
	for _, ip := range []string{"8.8.8.8", "127.0.0.1"} {
		local := ip == "127.0.0.1"
		for _, port := range []string{"0", "04001", "+4001", "-1", "65536", "4001 ", ""} {
			if err := ValidateQUICAddress("/ip4/"+ip+"/udp/"+port+"/quic-v1", local); err == nil {
				t.Errorf("noncanonical port accepted: %q", port)
			}
		}
		for _, port := range []string{"1", "65535"} {
			if err := ValidateQUICAddress("/ip4/"+ip+"/udp/"+port+"/quic-v1", local); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, value := range []string{"/ip4/127.0.0.2/udp/4001/quic-v1", "/ip4/10.0.0.1/udp/4001/quic-v1", "/ip4/8.8.8.8/udp/4001/quic-v1", "/ip4/127.0.0.1/udp/4001/quic-v1/p2p/peer", "/dns4/localhost/udp/4001/quic-v1"} {
		if err := ValidateQUICAddress(value, true); err == nil {
			t.Errorf("invalid loopback target accepted: %s", value)
		}
	}
}
