package main

import (
	"neuron-customer-app/neuron-go/directseller"
	"testing"
)

func TestDirectLoopbackCannotEnablePrivateOrCanonicalAddresses(t *testing.T) {
	loopback := &directseller.Profile{Transport: "loopback"}
	for _, value := range []string{"/ip4/127.0.0.1/udp/4001/quic-v1"} {
		if err := requireRequestUDPAddress(value, loopback); err != nil {
			t.Fatal(err)
		}
		if err := requireRequestUDPAddress(value, nil); err == nil {
			t.Fatal("canonical accepted loopback")
		}
		if err := requireRequestUDPAddress(value, &directseller.Profile{Transport: "public"}); err == nil {
			t.Fatal("public profile accepted loopback")
		}
	}
	for _, value := range []string{"/ip4/192.168.1.10/udp/4001/quic-v1", "/ip4/127.0.0.2/udp/4001/quic-v1",
		"/ip4/8.8.8.8/udp/4001/quic-v1", "/ip4/127.0.0.1/udp/0/quic-v1", "/ip4/127.0.0.1/udp/65536/quic-v1", "/ip4/127.0.0.1/tcp/4001"} {
		if err := requireRequestUDPAddress(value, loopback); err == nil {
			t.Fatalf("loopback profile accepted %s", value)
		}
	}
}

func TestRequestRejectsUndeliverableReservedAddressesBeforeHCS(t *testing.T) {
	for _, profile := range []*directseller.Profile{nil, {Transport: "public"}} {
		for _, ip := range []string{"100.64.0.1", "169.254.169.254", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1"} {
			if err := requireRequestUDPAddress("/ip4/"+ip+"/udp/4001/quic-v1", profile); err == nil {
				t.Errorf("request accepted undeliverable address %s", ip)
			}
		}
		if err := requireRequestUDPAddress("/ip4/8.8.8.8/udp/4001/quic-v1", profile); err != nil {
			t.Fatal(err)
		}
	}
	if err := requireRequestUDPAddress("/ip4/127.0.0.1/udp/04001/quic-v1", &directseller.Profile{Transport: "loopback"}); err == nil {
		t.Fatal("request accepted noncanonical loopback port")
	}
}
