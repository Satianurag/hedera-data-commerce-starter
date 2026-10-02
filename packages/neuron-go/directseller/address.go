package directseller

import (
	"errors"
	"net/netip"
	"strconv"
	"strings"
)

// PublicIPv4 applies the same conservative routing policy to request creation
// and seller delivery. IsGlobalUnicast alone includes private and reserved IPs.
func PublicIPv4(ip netip.Addr) bool {
	if !ip.Is4() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, s := range []string{"0.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"} {
		if netip.MustParsePrefix(s).Contains(ip) {
			return false
		}
	}
	return true
}

// ValidateQUICAddress requires one canonical IPv4 UDP QUIC target. The caller
// must separately authorize loopback mode and, for delivery, pin its exact port.
func ValidateQUICAddress(value string, loopback bool) error {
	parts := strings.Split(value, "/")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "ip4" || parts[3] != "udp" || parts[5] != "quic-v1" {
		return errors.New("target must be one literal IPv4 UDP QUIC address")
	}
	ip, err := netip.ParseAddr(parts[2])
	port, portErr := strconv.ParseUint(parts[4], 10, 16)
	if err != nil || !ip.Is4() || portErr != nil || port == 0 || strconv.FormatUint(port, 10) != parts[4] {
		return errors.New("invalid IPv4 address or canonical UDP port")
	}
	if loopback {
		if parts[2] != "127.0.0.1" {
			return errors.New("local transport requires exactly 127.0.0.1")
		}
	} else if !PublicIPv4(ip) {
		return errors.New("target is not public IPv4")
	}
	return nil
}
