# mservicebus

## Messaging
In today's microservice architectures, messaging is the integration mechanism
of choice. A service bus is a useful abstraction on message integration
patterns. This package implements a service bus with 2 of the more common 
messaging patterns:

1. Request-response
2. Publish-subscribe

The request-response pattern is useful for actions (commands and queries which
require acknowledgement or response data), whilst publish-subscribe is useful
for notification and other forms of event publication.

Messaging with mservicebus is based on AMQP. AMQP-style topic patterns are used
for routing messages.

## Event replay
When event sourcing is applied to a microservice architecure, there is often 
the need to replay events. For instance a failing service may require that 
another service replay events that it missed during downtime.
This presents the unique challenge that whilst similar to a request-response 
pattern, order, idempotence and clustering need to be considered.
This package provides a solution with nodejs streams, and AMQP styled topic
patterns.

## Getting started

```
npm install mservice bus
```

## Sample Code
```
var servicebus = require('mservicebus');

//respond to a command
servicebus.respond('mysservice.action1', function(command, callback){
  //put code to handle command here
  //publish events
  servicebus.publish('myservice.events.ActionOccurred', {prop1:'val1'});
  //acknowledge command
  callback();
});

//resond to a query
servicebus.respond('myservice.query.resource1', function(query, callback){
  //put code to read from data base here
  callback(null, data);
});

//respond to a request to replay certain events
servicebus.stream('myservice.replay.ActionOccured', function(options, stream){
  //write replayed events to stream here
  stream.write({prop1:'valuex'});
  stream.close();
});


//run command from another service
servicebus.request('myotherservice.actionx', function(err){
  //put code to handle error or no error here
});

//subscribe to events from another service
servicebus.subscribe('myotherservice.events.*.asked.#', function(qualifier, event){
  //put code to handle event here
});

//request stream of events from another service on startup
servicebus.requestStream('myotherservice.replays.event', function(err, stream){
  //work with stream here
});
```


