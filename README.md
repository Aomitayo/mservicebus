# mservicebus

In today's distributed-system architectures, messaging is the integration
mechanism of choice. Whether microservices-styled, or actor-model based, Most 
systems are implemented as message-passing systems. A service bus is an 
abstraction on message exchange patterns. It is the fabric that holds the 
components together.

**mservicebus** is an opinionated implementation of a service bus. With emphasis
on ease of use and scalability, it uses nodejs callbacks and streams as
abstractions on message exchange patterns.
Although it is based on AMQP. It seeks to remove the burden of managing the 
details about connections, channels, queues, and message acknowledgement. It
does however, provide the means to explicitly make some of the important choices
when scaling out.

mservicebus support x message patterns:
- request-response
- publish-subscribe
- XXXXXXXX

## Getting started

```
npm install mservicebus
```

## Instantiate and connect to an AMQP message broker such as rabbitmq

```
var Servicebus = require('mservicebus');

var servicebus = new Servicebus({
	//options for amqp and timeouts
	name: 'myservicebus',	//Will be used as the name of the topic exchange for pubsub 
	timeout: 50000,
	amqp:{
		url:'amqp://localhost:5762',
	}
});
```

## Request-Response

Request-Response is most useful for implementing Actions - commands or
queries; in a sense, RPCs(Remote Procedure calls).
mservicebus uses node-style callback api for defining and invoking actions.

```
//Send a request
servicebus.request('myotherservice.query1', {param1:'value1'}, function(err, results){
	// put code to handle error or use results here
});

//Recieve a request and send a response
servicebus.fulfill('myservice.command1', function(request, callback){
		//put code to perform action here
		// this will be the main action 
		// It is the function at the bottom of the stack of function registered
		// for the named action
	})
	.use(function middleware1(request, next){	//use simple middleware
		//put code to execute middleware action
		next();
	})
	.put(1, function middleware3(request, response, next){	//place middleware at index 1
		//put code to execute middleware action
		next();	
	})
	.putBefore('middleware3', function middleware2 (request, response, next){	//put middleware before 'middleware3'
		//put code to execute middleware action
		next();
	})
	.handleError(function(err, args, next){	//use error middleware
		//put code to handle error here
	});

```

## Publish-subscribe
Publish-subscribe is useful for event publication.
In many cases, subscribers make changes in response to events. As there may be
multiple instances of a given subscriber running concurrently, A clear
decision has to made about how to handle such a scenario. 
```
servicebus.subscribe('myotherservice.stock.nyse.#', function(event){
	//put code to handle event here
});

servicebus.publish('myservice.stock.acme', {
	//event data goes here
});
```

## Middleware & Fluent Api

mservicebus provides a fluent api for using middleware functions. 

```
servicebus.fulfill('myservice.command1', function(request, callback){
		//put code to perform action here
		// this will be the main action 
		// It is the function at the bottom of the stack of function registered
		// for the named action
	})
	.use(function middleware1(request, next){	//use simple middleware
		//put code to execute middleware action
		next();
	})
	.put(1, function middleware3(request, response, next){	//place middleware at index 1
		//put code to execute middleware action
		next();	
	})
	.putBefore('middleware3', function middleware2 (request, response, next){	//put middleware before 'middleware3'
		//put code to execute middleware action
		next();
	})
	.handleError(function(err, args, next){	//use error middleware
		//put code to handle error here
	});


```
##Event replay

```
servicebus.replay('myservice.event.stream', function(args, stream){
	eventStore.getEvent(args, function(events){
		events.forEach(function(event){
			stream.write(event);
		});
		stream.close();
});

servicebus.requestReplay('myotherservice.event.name', function(err, stream){
	//put code to handle error, or read event objects from stream
})
```

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## History

TODO: Write history

## Credits

Adedayo Omitayo 
	- https://github.com/Aomitayo

## License

[MIT](LICENSE)
