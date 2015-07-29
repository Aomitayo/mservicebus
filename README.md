# mservicebus

In today's microservice architectures, messaging is the integration mechanism
of choice. A service bus is a useful abstraction on these message integration
patterns. This package implements a service bus with 2 of the more common 
messaging patterns:

1. Request-response
2. Publish-subscribe

The request-response pattern is useful for actions (commands and queries which
require acknowledgement or response data), whilst publish-subscribe is useful
for notification and other forms of event publication.

## Event replay
When event sourcing is applied to a microservice architecure, there is often 
the need to replay events. For instance a failing service may require that 
another service replay events that it missed during downtime.
This presents the unique challenge that whilst similar to a request-response 
pattern, order, idempotence and clustering need to be considered.
This package provides a solution with nodejs streams, and AMQP styled topic
patterns.
